/**
 * Data-access and business logic for users.
 *
 * Owns all reads/writes to the `User` collection and the rules around them:
 * uniqueness of email/username, soft deletion, and projecting a safe "public"
 * view of a user for other players.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AccountStatus, User, UserDocument } from './schemas/user.schema';
import { validateDto } from '../common/validation/validate-dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AVATAR_DIR } from './avatar-upload';

/** Fields safe to expose when another player views a profile. */
export interface PublicProfile {
  id: string;
  first_name: string;
  last_name: string;
  username: string;
  profile_picture: string | null;
  reputation: number;
  is_flaker: boolean;
  account_status: string;
  skill_levels: Record<string, string>;
  // Deprecated legacy skill map, exposed only as a read fallback.
  preferred_positions: Record<string, string>;
  games_created: number;
  games_joined: number;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * Create a user. Expects an already-hashed password. Rejects duplicate
   * email/username with a 409 instead of leaking a raw Mongo duplicate-key error.
   */
  async create(data: {
    first_name: string;
    last_name: string;
    username: string;
    email: string;
    password: string;
  }): Promise<UserDocument> {
    const existing = await this.userModel
      .findOne({ $or: [{ email: data.email }, { username: data.username }] })
      .exec();
    if (existing) {
      throw new ConflictException('Email or username already in use');
    }
    return this.userModel.create(data);
  }

  /** Look up by email. Pass `withPassword` during login to include the hash. */
  findByEmail(email: string, withPassword = false): Promise<UserDocument | null> {
    const query = this.userModel.findOne({ email });
    if (withPassword) {
      query.select('+password');
    }
    return query.exec();
  }

  /** Fetch a user by id, or null. Pass `withPassword` to include the hash. */
  findById(id: string, withPassword = false): Promise<UserDocument | null> {
    const query = this.userModel.findById(id);
    if (withPassword) {
      query.select('+password');
    }
    return query.exec();
  }

  /** Fetch a non-soft-deleted user by id (used by auth to validate a token). */
  findActiveById(id: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ _id: id, deleted_at: null }).exec();
  }

  /**
   * Promote a pending account to active after email verification. Deliberately
   * a no-op for any other status so verification can never lift a suspension.
   */
  async activatePendingByEmail(email: string): Promise<void> {
    await this.userModel
      .updateOne(
        { email, account_status: AccountStatus.Pending, deleted_at: null },
        { account_status: AccountStatus.Active },
      )
      .exec();
  }

  /**
   * Set a new password (already hashed) after a verified reset.
   *
   * `password_changed_at` is stamped in the same write: `JwtStrategy` rejects
   * any token issued before it, so a reset immediately logs out every existing
   * session — without that, an attacker holding a stolen JWT keeps their access
   * until it expires on its own, which defeats the purpose of resetting.
   *
   * Suspended accounts are filtered out at the caller (`forgotPassword` never
   * mails them a link); soft-deleted ones are refused here too, so a link issued
   * before a deletion cannot resurrect the credentials.
   */
  async updatePasswordByEmail(
    email: string,
    passwordHash: string,
  ): Promise<void> {
    await this.userModel
      .updateOne(
        { email, deleted_at: null },
        { password: passwordHash, password_changed_at: new Date() },
      )
      .exec();
  }

  /**
   * Set a new password (already hashed) by id — the authenticated-change-password
   * counterpart to `updatePasswordByEmail`. Also stamps `password_changed_at`,
   * which retires every JWT issued before this call, including the one used to
   * make this very request.
   */
  async updatePasswordById(id: string, passwordHash: string): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: id, deleted_at: null },
        { password: passwordHash, password_changed_at: new Date() },
      )
      .exec();
  }

  /**
   * Update the editable parts of a profile. Re-checks username uniqueness so a
   * rename cannot collide with another user.
   */
  async updateProfile(
    id: string,
    payload: UpdateProfileDto,
  ): Promise<UserDocument> {
    const dto = await validateDto(UpdateProfileDto, payload);

    if (dto.username) {
      const clash = await this.userModel
        .findOne({ username: dto.username, _id: { $ne: id } })
        .exec();
      if (clash) {
        throw new ConflictException('Username already in use');
      }
    }

    const updated = await this.userModel
      .findOneAndUpdate({ _id: id, deleted_at: null }, dto, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  /**
   * Point a user's row at a freshly uploaded avatar (already written to disk by
   * Multer) and remove the file it replaces. If the user is gone, the new file
   * is cleaned up so a failed request never leaves an orphan behind.
   */
  async setProfilePicture(
    id: string,
    publicPath: string,
  ): Promise<UserDocument> {
    const current = await this.findActiveById(id);
    if (!current) {
      await this.deleteAvatarFile(publicPath);
      throw new NotFoundException('User not found');
    }

    const previous = current.profile_picture;
    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: id, deleted_at: null },
        { profile_picture: publicPath },
        { new: true },
      )
      .exec();
    if (!updated) {
      await this.deleteAvatarFile(publicPath);
      throw new NotFoundException('User not found');
    }

    if (previous && previous !== publicPath) {
      await this.deleteAvatarFile(previous);
    }
    return updated;
  }

  /**
   * Clear a user's avatar and delete the underlying file. A no-op removal (no
   * picture set) simply returns the user unchanged.
   */
  async removeProfilePicture(id: string): Promise<UserDocument> {
    const current = await this.findActiveById(id);
    if (!current) {
      throw new NotFoundException('User not found');
    }

    const previous = current.profile_picture;
    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: id, deleted_at: null },
        { profile_picture: null },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException('User not found');
    }

    if (previous) {
      await this.deleteAvatarFile(previous);
    }
    return updated;
  }

  /**
   * Best-effort deletion of a stored avatar file. Only the basename is used so a
   * stored path can never point outside the avatar directory, and a missing file
   * is ignored — the row is the source of truth, the file just backs it.
   */
  private async deleteAvatarFile(publicPath: string): Promise<void> {
    try {
      await unlink(join(AVATAR_DIR, basename(publicPath)));
    } catch {
      // Already gone (manual cleanup, prior failure) — nothing to do.
    }
  }

  /**
   * Soft-delete: stamp `deleted_at` and keep the document. Idempotent-ish — a
   * missing or already-deleted user yields a 404.
   */
  async softDelete(id: string): Promise<void> {
    const result = await this.userModel
      .findOneAndUpdate(
        { _id: id, deleted_at: null },
        { deleted_at: new Date() },
      )
      .exec();
    if (!result) {
      throw new NotFoundException('User not found');
    }
  }

  /** Record that a user hosted a game (idempotent via `$addToSet`). */
  async addCreatedGame(userId: string, gameId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $addToSet: { games_created: gameId } })
      .exec();
  }

  /** Record that a user joined a game (idempotent via `$addToSet`). */
  async addJoinedGame(userId: string, gameId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $addToSet: { games_joined: gameId } })
      .exec();
  }

  /** Remove a game from a user's joined list when they leave. */
  async removeJoinedGame(userId: string, gameId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $pull: { games_joined: gameId } })
      .exec();
  }

  /** Remove a game from a user's created list when the host deletes it. */
  async removeCreatedGame(userId: string, gameId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $pull: { games_created: gameId } })
      .exec();
  }

  /**
   * Bookmark a game for the user ("save"). Idempotent via `$addToSet`, so
   * saving an already-saved game is a no-op. Returns the updated user so the
   * caller sees the new `saved_games`. Saving never touches the game's roster.
   */
  async saveGame(userId: string, gameId: string): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(gameId)) {
      throw new BadRequestException('Invalid game id');
    }
    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: userId, deleted_at: null },
        { $addToSet: { saved_games: gameId } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  /** Remove a game from the user's saved list. Idempotent via `$pull`. */
  async unsaveGame(userId: string, gameId: string): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(gameId)) {
      throw new BadRequestException('Invalid game id');
    }
    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: userId, deleted_at: null },
        { $pull: { saved_games: gameId } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  /**
   * The full game documents the user has saved, newest-saved first. Games that
   * were since deleted populate as null and are filtered out, so a stale
   * bookmark never surfaces a broken entry.
   */
  async getSavedGames(userId: string): Promise<unknown[]> {
    const user = await this.userModel
      .findOne({ _id: userId, deleted_at: null })
      .populate('saved_games')
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return (user.saved_games as unknown[]).filter((g) => g != null).reverse();
  }

  /** Fetch the public view of an active user, or 404 if missing/deleted. */
  async getPublicProfile(id: string): Promise<PublicProfile> {
    const user = await this.findActiveById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
      profile_picture: user.profile_picture ?? null,
      reputation: user.reputation,
      is_flaker: user.is_flaker,
      account_status: user.account_status,
      // Mongoose stores these as Maps; expose them as plain objects for JSON.
      skill_levels: user.skill_levels ? Object.fromEntries(user.skill_levels) : {},
      preferred_positions: user.preferred_positions
        ? Object.fromEntries(user.preferred_positions)
        : {},
      games_created: user.games_created.length,
      games_joined: user.games_joined.length,
    };
  }


  async isUsernameTaken(username: string): Promise<boolean>{
    const existing = await this.userModel
      .findOne({ username, deleted_at: null })
      // optional: case-insensitive match so "UserName" ≈ "username"
      .collation({ locale: 'en', strength: 2 })
      .exec();
    return !!existing;
  }
}
