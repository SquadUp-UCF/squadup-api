/**
 * Data-access and business logic for pickup games.
 *
 * Owns the game lifecycle: hosting, discovery, roster changes (join/leave), and
 * host-only transitions (update/cancel/complete). Status is never set directly
 * by a client — it is recomputed from the active roster after every change and
 * pinned once a game reaches a terminal state (`completed`/`cancelled`).
 *
 * The acting user is always supplied by the controller from the JWT, never from
 * the request body. User-side bookkeeping (`games_created`/`games_joined`) is
 * delegated to `UsersService` so all writes to the `User` collection stay there.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Game, GameDocument, GameStatus, ParticipantStatus } from './schemas/game.schema';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { JoinGameDto } from './dto/join-game.dto';
import { ListGamesDto } from './dto/list-games.dto';
import { MyGamesDto, MyGamesRole } from './dto/my-games.dto';
import { validateDto } from '../common/validation/validate-dto';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { bannerForSport, isStockBanner } from './sport-banners';
import { BANNER_DIR } from './banner-upload';

const TERMINAL_STATUSES: GameStatus[] = [
  GameStatus.Completed,
  GameStatus.Cancelled,
];

@Injectable()
export class GamesService {
  constructor(
    @InjectModel(Game.name) private readonly gameModel: Model<GameDocument>,
    private readonly usersService: UsersService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Host a new game. The host is auto-added as the first participant (counting
   * toward min/max) and the game is recorded on their profile.
   */
  async create(hostId: string, payload: CreateGameDto): Promise<GameDocument> {
    const dto = await validateDto(CreateGameDto, payload);

    if (dto.min_players > dto.max_players) {
      throw new BadRequestException('min_players cannot exceed max_players');
    }
    if (new Date(dto.start_time).getTime() <= Date.now()) {
      throw new BadRequestException('start_time must be in the future');
    }

    const game = await this.gameModel.create({
      ...dto,
      host: hostId,
      // Banner: the host's own image if they supplied one, else the sport's
      // stock banner (a generic default for unrecognized sports).
      photo_url: dto.photo_url?.trim() || bannerForSport(dto.sport),
      participants: [{ user: hostId, status: ParticipantStatus.Joined }],
    });

    await this.usersService.addCreatedGame(hostId, game.id);
    return game;
  }

  /** Discovery listing. Filters by sport, status, and (by default) upcoming. */
  async findMany(filters: ListGamesDto): Promise<GameDocument[]> {
    // Validate/coerce the raw query first — this runs the DTO's @Transform so
    // `upcoming=false` becomes the boolean false (query strings arrive as text,
    // and there's no global ValidationPipe to transform them).
    const dto = await validateDto(ListGamesDto, filters);
    const query: Record<string, unknown> = {};
    if (dto.sport) {
      query.sport = dto.sport;
    }
    if (dto.status) {
      query.status = dto.status;
    }
    if (dto.upcoming !== false) {
      query.start_time = { $gt: new Date() };
    }
    return this.gameModel.find(query).sort({ start_time: 1 }).exec();
  }

  findForUser(userId: string, filters: MyGamesDto): Promise<GameDocument[]> {
    const hosting = { host: userId };
    const playing = {
      participants: {
        $elemMatch: { user: userId, status: ParticipantStatus.Joined },
      },
    };

    const query: Record<string, unknown> =
      filters.role === MyGamesRole.Hosting
        ? { ...hosting }
        : filters.role === MyGamesRole.Playing
          ? { ...playing }
          : { $or: [hosting, playing] };

    if (filters.status) {
      query.status = filters.status;
    }
    return this.gameModel.find(query).sort({ start_time: 1 }).exec();
  }

  async findByIdOrFail(id: string): Promise<GameDocument> {
    const game = await this.gameModel.findById(id).exec();
    if (!game) {
      throw new NotFoundException('Game not found');
    }
    return game;
  }

  async update(
    id: string,
    userId: string,
    payload: UpdateGameDto,
  ): Promise<GameDocument> {
    const dto = await validateDto(UpdateGameDto, payload);
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    const prevPhoto = game.photo_url;
    Object.assign(game, dto);

    // Keep the banner in step with the sport when it's still a stock default
    // and the host isn't setting their own image in this same edit — so
    // switching sports doesn't leave the old sport's banner behind, but a
    // custom picture is never clobbered.
    if (
      dto.sport !== undefined &&
      dto.photo_url === undefined &&
      isStockBanner(prevPhoto)
    ) {
      game.photo_url = bannerForSport(game.sport);
    }

    if (game.min_players > game.max_players) {
      throw new BadRequestException('min_players cannot exceed max_players');
    }

    this.recomputeStatus(game);
    return game.save();
  }

  /**
   * Join a game's roster. `partySize` is the total headcount this join
   * represents (the caller plus however many they're bringing) — it counts
   * toward `min_players`/`max_players` in place of a flat 1-per-participant
   * count, so a join is rejected if the group wouldn't fit in the remaining
   * spots even though the roster isn't technically full yet.
   */
  async join(id: string, userId: string, payload: JoinGameDto = {}): Promise<GameDocument> {
    const dto = await validateDto(JoinGameDto, payload);
    const partySize = dto.party_size ?? 1;
    const game = await this.findByIdOrFail(id);

    if (game.status === GameStatus.Locked) {
      throw new BadRequestException('Game is full');
    }
    if (this.isTerminal(game)) {
      throw new BadRequestException('Game is not open for joining');
    }
    if (game.start_time.getTime() <= Date.now()) {
      throw new BadRequestException('Game has already started');
    }

    const existing = game.participants.find(
      (p) => p.user.toString() === userId,
    );
    if (existing?.status === ParticipantStatus.Joined) {
      throw new BadRequestException('Already joined this game');
    }

    const remaining = game.max_players - this.activePartySize(game);
    if (partySize > remaining) {
      throw new BadRequestException(
        remaining <= 0
          ? 'Game is full'
          : `Only ${remaining} spot${remaining === 1 ? '' : 's'} left`,
      );
    }

    if (existing) {
      existing.status = ParticipantStatus.Joined;
      existing.joined_at = new Date();
      existing.party_size = partySize;
    } else {
      game.participants.push({
        user: userId as unknown as GameDocument['participants'][number]['user'],
        status: ParticipantStatus.Joined,
        joined_at: new Date(),
        party_size: partySize,
      });
    }

    const prevStatus = game.status;
    this.recomputeStatus(game);
    await game.save();
    await this.usersService.addJoinedGame(userId, game.id);

    // Notify host that someone joined
    this.notificationsService.sendToUser({
      userId: game.host.toString(),
      type: NotificationType.PlayerJoined,
      title: 'Someone joined your game!',
      body: `A new player joined your ${game.sport} game.`,
      gameId: game.id,
    }).catch(() => {});

    // Notify all participants if status changed
    if (prevStatus !== game.status) {
  const activeParticipants = game.participants
    .filter(p => p.status === ParticipantStatus.Joined)
    .map(p => p.user.toString());

  const newStatus = game.status as GameStatus;

  if (newStatus === GameStatus.Confirmed) {
    for (const participantId of activeParticipants) {
      this.notificationsService.sendToUser({
        userId: participantId,
        type: NotificationType.GameConfirmed,
        title: 'Game confirmed!',
        body: `Your ${game.sport} game has enough players and is confirmed.`,
        gameId: game.id,
      }).catch(() => {});
    }
  } else if (newStatus === GameStatus.Locked) {
    for (const participantId of activeParticipants) {
      this.notificationsService.sendToUser({
        userId: participantId,
        type: NotificationType.GameLocked,
        title: 'Game is full!',
        body: `Your ${game.sport} game is now full.`,
        gameId: game.id,
      }).catch(() => {});
    }
  }
}
return game;
}

  async leave(id: string, userId: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertNotTerminal(game);

    if (game.host.toString() === userId) {
      throw new BadRequestException(
        'Host cannot leave their own game; cancel it instead',
      );
    }

    const participant = game.participants.find(
      (p) =>
        p.user.toString() === userId &&
        p.status === ParticipantStatus.Joined,
    );
    if (!participant) {
      throw new BadRequestException('You are not on this game roster');
    }

    participant.status = ParticipantStatus.Cancelled;
    this.recomputeStatus(game);
    await game.save();
    await this.usersService.removeJoinedGame(userId, game.id);
    return game;
  }

  async cancel(id: string, userId: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    game.status = GameStatus.Cancelled;
    await game.save();

    // Notify all participants the game was cancelled
    const activeParticipants = game.participants
      .filter(p => p.status === ParticipantStatus.Joined && p.user.toString() !== userId)
      .map(p => p.user.toString());

    for (const participantId of activeParticipants) {
      this.notificationsService.sendToUser({
        userId: participantId,
        type: NotificationType.GameCancelled,
        title: 'Game cancelled',
        body: `The ${game.sport} game you joined has been cancelled.`,
        gameId: game.id,
      }).catch(() => {});
    }

    return game;
  }

  async complete(id: string, userId: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    game.status = GameStatus.Completed;
    return game.save();
  }

  /**
   * Permanently delete a game (host only). Unlike `cancel`, which keeps the
   * record in a terminal state, this removes the document and untracks it from
   * the host's created list. Any joined players still notified via cancel are
   * not messaged here — deletion is for games posted in error.
   */
  async remove(id: string, userId: string): Promise<void> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);

    await this.gameModel.deleteOne({ _id: game.id }).exec();
    await this.usersService.removeCreatedGame(userId, game.id);
  }

  /**
   * Point a game's banner at a freshly uploaded image (already written to
   * disk by Multer) and remove the file it replaces — but only when that
   * previous file was itself a host upload, never a committed stock banner.
   */
  async setPhoto(id: string, userId: string, publicPath: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);

    const previous = game.photo_url;
    game.photo_url = publicPath;
    await game.save();

    if (!isStockBanner(previous)) {
      await this.deleteBannerFile(previous as string);
    }
    return game;
  }

  /**
   * Revert a game's banner to the sport's stock default, removing the
   * uploaded file if one was set.
   */
  async removePhoto(id: string, userId: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);

    const previous = game.photo_url;
    game.photo_url = bannerForSport(game.sport);
    await game.save();

    if (!isStockBanner(previous)) {
      await this.deleteBannerFile(previous as string);
    }
    return game;
  }

  /**
   * Best-effort deletion of a stored banner file. Only the basename is used so
   * a stored path can never point outside the banner directory, and a missing
   * file is ignored — the row is the source of truth, the file just backs it.
   */
  private async deleteBannerFile(publicPath: string): Promise<void> {
    try {
      await unlink(join(BANNER_DIR, basename(publicPath)));
    } catch {
      // Already gone (manual cleanup, prior failure) — nothing to do.
    }
  }

  // --- helpers -------------------------------------------------------------

  private isTerminal(game: GameDocument): boolean {
    return TERMINAL_STATUSES.includes(game.status);
  }

  private assertNotTerminal(game: GameDocument): void {
    if (this.isTerminal(game)) {
      throw new BadRequestException(`Game is already ${game.status}`);
    }
  }

  private assertHost(game: GameDocument, userId: string): void {
    if (game.host.toString() !== userId) {
      throw new ForbiddenException('Only the host can perform this action');
    }
  }

  /** Sum of `party_size` across `joined` participants — the real headcount. */
  private activePartySize(game: GameDocument): number {
    return game.participants
      .filter((p) => p.status === ParticipantStatus.Joined)
      .reduce((sum, p) => sum + (p.party_size || 1), 0);
  }

  private recomputeStatus(game: GameDocument): void {
    if (this.isTerminal(game)) {
      return;
    }
    const active = this.activePartySize(game);

    if (active >= game.max_players) {
      game.status = GameStatus.Locked;
    } else if (active >= game.min_players) {
      game.status = GameStatus.Confirmed;
    } else {
      game.status = GameStatus.Open;
    }
  }
}