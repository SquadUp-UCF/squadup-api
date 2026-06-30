/**
 * Data-access and business logic for users.
 *
 * Owns all reads/writes to the `User` collection and the rules around them:
 * uniqueness of email/username, soft deletion, and projecting a safe "public"
 * view of a user for other players.
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { UpdateProfileDto } from './dto/update-profile.dto';

/** Fields safe to expose when another player views a profile. */
export interface PublicProfile {
  id: string;
  first_name: string;
  last_name: string;
  username: string;
  reputation: number;
  is_flaker: boolean;
  account_status: string;
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

  /** Fetch a user by id, or null. */
  findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  /** Fetch a non-soft-deleted user by id (used by auth to validate a token). */
  findActiveById(id: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ _id: id, deleted_at: null }).exec();
  }

  /**
   * Update the editable parts of a profile. Re-checks username uniqueness so a
   * rename cannot collide with another user.
   */
  async updateProfile(
    id: string,
    dto: UpdateProfileDto,
  ): Promise<UserDocument> {
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
      reputation: user.reputation,
      is_flaker: user.is_flaker,
      account_status: user.account_status,
      games_created: user.games_created.length,
      games_joined: user.games_joined.length,
    };
  }
}
