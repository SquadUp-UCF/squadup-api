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
import { CreateGameDto, InitialPlayerDto } from './dto/create-game.dto';
import { SetPositionDto } from './dto/set-position.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { JoinGameDto } from './dto/join-game.dto';
import { ListGamesDto } from './dto/list-games.dto';
import { MyGamesDto, MyGamesRole } from './dto/my-games.dto';
import { RateGameDto } from './dto/rate-game.dto';
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

// How long a game stays in discovery past its start time before it's treated as
// over and hidden — unless the host ends/cancels it sooner. Four hours covers a
// long session (double-headers, extra innings) without leaving stale games up.
const DISCOVERY_GRACE_MS = 4 * 60 * 60 * 1000;

// How much a single thumbs up/down nudges a rated player's 0–5 reputation.
const RATING_DELTA = { up: 0.1, down: -0.2 } as const;

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

    // Guest players the host pre-adds, plus the host's own optional position.
    // These are kept off `gameData` (not Game fields) — they shape the roster
    // below. Blank names are dropped; a blank position is treated as unset.
    const { players = [], host_position, ...gameData } = dto;
    const hostPosition = host_position?.trim() || undefined;
    const guests = players
      .map((p) => ({ name: p.name?.trim() ?? '', position: p.position?.trim() || undefined }))
      .filter((g) => g.name.length > 0);

    // The host (1) plus each guest (party_size 1) must fit the max roster.
    if (1 + guests.length > dto.max_players) {
      throw new BadRequestException(
        `Too many initial players for a max roster of ${dto.max_players}`,
      );
    }

    const game = await this.gameModel.create({
      ...gameData,
      host: hostId,
      // Banner: the host's own image if they supplied one, else the sport's
      // stock banner (a generic default for unrecognized sports).
      photo_url: dto.photo_url?.trim() || bannerForSport(dto.sport),
      participants: [
        {
          user: hostId,
          status: ParticipantStatus.Joined,
          ...(hostPosition ? { position: hostPosition } : {}),
        },
        ...guests.map((g) => ({
          name: g.name,
          status: ParticipantStatus.Joined,
          ...(g.position ? { position: g.position } : {}),
        })),
      ],
    });

    // A pre-filled roster can already satisfy min/max, so reflect that instead
    // of always starting `open`.
    if (guests.length > 0) {
      this.recomputeStatus(game);
      await game.save();
    }

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
    if (dto.skill_level) {
      query.skill_level = dto.skill_level;
    }
    if (dto.upcoming !== false) {
      // A game stays discoverable during and shortly after its slot: it drops
      // off once it's more than DISCOVERY_GRACE_MS past its start time (a game
      // that already happened), or as soon as the host ends it (completed) or
      // cancels it. An explicit `status` filter takes precedence over the
      // "hide ended games" default.
      query.start_time = { $gt: new Date(Date.now() - DISCOVERY_GRACE_MS) };
      if (!dto.status) {
        query.status = {
          $nin: [GameStatus.Completed, GameStatus.Cancelled],
        };
      }
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
    // Snapshot the details a player plans around, so an edit to any of them can
    // be announced to the roster below. Read before Object.assign, and compared
    // against the DTO rather than the doc (start_time is still an ISO string
    // in memory until Mongoose casts it on save).
    const before = {
      sport: game.sport,
      location: game.location,
      start_time: game.start_time?.getTime(),
    };

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
    const saved = await game.save();

    const changes: string[] = [];
    if (dto.start_time !== undefined && new Date(dto.start_time).getTime() !== before.start_time) {
      changes.push('time');
    }
    if (dto.location !== undefined && dto.location !== before.location) {
      changes.push('location');
    }
    if (dto.sport !== undefined && dto.sport !== before.sport) {
      changes.push('sport');
    }

    // Only the details a player plans around are worth interrupting them for —
    // a description or banner tweak isn't. The host made the edit, so they're
    // skipped even if they're on their own roster.
    if (changes.length > 0) {
      const summary =
        changes.length === 1
          ? changes[0]
          : `${changes.slice(0, -1).join(', ')} and ${changes[changes.length - 1]}`;

      const roster = saved.participants
        .filter(
          (p) =>
            p.status === ParticipantStatus.Joined &&
            p.user &&
            p.user.toString() !== userId,
        )
        .map((p) => p.user!.toString());

      for (const participantId of roster) {
        this.notificationsService.sendToUser({
          userId: participantId,
          type: NotificationType.GameUpdated,
          title: 'Game updated',
          body: `The ${before.sport} game you joined changed its ${summary}.`,
          gameId: saved.id,
        }).catch(() => {});
      }
    }

    return saved;
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
    // Named guests the caller brings; each is its own roster entry (party_size
    // 1). When guests are given, the caller counts as 1 and party_size is
    // ignored — otherwise fall back to the anonymous party_size headcount.
    const guests = (dto.guests ?? [])
      .map((g) => ({ name: g.name?.trim() ?? '', position: g.position?.trim() || undefined }))
      .filter((g) => g.name.length > 0);
    const partySize = guests.length > 0 ? 1 : dto.party_size ?? 1;
    const needed = partySize + guests.length;
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
      (p) => p.user?.toString() === userId,
    );
    if (existing?.status === ParticipantStatus.Joined) {
      throw new BadRequestException('Already joined this game');
    }

    const remaining = game.max_players - this.activePartySize(game);
    if (needed > remaining) {
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

    for (const g of guests) {
      game.participants.push({
        name: g.name,
        status: ParticipantStatus.Joined,
        joined_at: new Date(),
        party_size: 1,
        ...(g.position ? { position: g.position } : {}),
      } as GameDocument['participants'][number]);
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
    .filter((p) => p.status === ParticipantStatus.Joined && p.user)
    .map((p) => p.user!.toString());

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
        p.user?.toString() === userId &&
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

  /**
   * Host-only: add a guest player (someone who may not have an account) to an
   * existing game's roster — the same kind of entry the host can seed at
   * creation. A guest counts toward min/max like any player.
   */
  async addGuest(
    id: string,
    userId: string,
    payload: InitialPlayerDto,
  ): Promise<GameDocument> {
    const dto = await validateDto(InitialPlayerDto, payload);
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    if (game.status === GameStatus.Locked) {
      throw new BadRequestException('Game is full');
    }
    if (game.start_time.getTime() <= Date.now()) {
      throw new BadRequestException('Game has already started');
    }
    if (this.activePartySize(game) >= game.max_players) {
      throw new BadRequestException('Game is full');
    }

    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Guest name is required');
    }
    const position = dto.position?.trim() || undefined;

    game.participants.push({
      name,
      status: ParticipantStatus.Joined,
      ...(position ? { position } : {}),
    } as unknown as GameDocument['participants'][number]);

    this.recomputeStatus(game);
    return game.save();
  }

  /**
   * Host-only: remove a guest from the roster by its index in `participants`.
   * Only guest entries (no linked `user`) can be removed this way — registered
   * players leave via `leave`.
   */
  async removeGuest(
    id: string,
    userId: string,
    index: number,
  ): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    const participant = game.participants[index];
    if (!participant || participant.user) {
      throw new BadRequestException('No guest at that position on the roster');
    }

    game.participants.splice(index, 1);
    this.recomputeStatus(game);
    return game.save();
  }

  /**
   * Set (or clear) the authenticated caller's own position on a game they're
   * actively on — the host or any joined registered player. Sending an empty
   * position clears it. Does not affect the roster count or status.
   */
  async setMyPosition(
    id: string,
    userId: string,
    payload: SetPositionDto,
  ): Promise<GameDocument> {
    const dto = await validateDto(SetPositionDto, payload);
    const game = await this.findByIdOrFail(id);
    this.assertNotTerminal(game);

    const participant = game.participants.find(
      (p) =>
        p.user?.toString() === userId &&
        p.status === ParticipantStatus.Joined,
    );
    if (!participant) {
      throw new BadRequestException('You are not on this game roster');
    }

    participant.position = dto.position?.trim() || undefined;
    return game.save();
  }

  async cancel(id: string, userId: string): Promise<GameDocument> {
    const game = await this.findByIdOrFail(id);
    this.assertHost(game, userId);
    this.assertNotTerminal(game);

    game.status = GameStatus.Cancelled;
    await game.save();

    // Notify all participants the game was cancelled
    const activeParticipants = game.participants
      .filter(
        (p) =>
          p.status === ParticipantStatus.Joined &&
          p.user &&
          p.user.toString() !== userId,
      )
      .map((p) => p.user!.toString());

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
   * Record a player's thumbs up/down for the other participants of a completed
   * game. Each rating nudges the rated user's reputation; the rater is recorded
   * in `rated_by` so they can't rate the same game twice.
   */
  async rateGame(id: string, raterId: string, payload: RateGameDto): Promise<GameDocument> {
    const dto = await validateDto(RateGameDto, payload);
    const game = await this.findByIdOrFail(id);

    if (game.status !== GameStatus.Completed) {
      throw new BadRequestException('You can only rate a completed game');
    }
    const isParticipant = game.participants.some(
      (p) => p.user?.toString() === raterId && p.status === ParticipantStatus.Joined,
    );
    if (!isParticipant) {
      throw new ForbiddenException('Only players in this game can rate it');
    }
    if (game.rated_by.some((u) => u.toString() === raterId)) {
      throw new BadRequestException('You have already rated this game');
    }

    // Only joined, registered participants other than the rater can be rated.
    const rateable = new Set(
      game.participants
        .filter((p) => p.user && p.status === ParticipantStatus.Joined)
        .map((p) => p.user!.toString())
        .filter((uid) => uid !== raterId),
    );

    for (const r of dto.ratings) {
      if (rateable.has(r.user)) {
        await this.usersService.adjustReputation(r.user, RATING_DELTA[r.value]);
      }
    }

    game.rated_by.push(raterId as unknown as GameDocument['rated_by'][number]);
    return game.save();
  }

  /**
   * Completed games the user played in but hasn't rated yet — drives the
   * "rate your teammates" prompt when they open the app or refresh the feed.
   */
  findPendingRatings(userId: string): Promise<GameDocument[]> {
    return this.gameModel
      .find({
        status: GameStatus.Completed,
        participants: {
          $elemMatch: { user: userId, status: ParticipantStatus.Joined },
        },
        rated_by: { $ne: userId },
      })
      .sort({ updatedAt: -1 })
      .exec();
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