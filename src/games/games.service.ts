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
          added_by: hostId,
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

    // Same "must be in the future" rule `create` enforces — only checked
    // when the edit actually touches start_time, so fixing an unrelated
    // field (e.g. the description) on a game that's already started/passed
    // doesn't force the host to also bump its time.
    if (
      dto.start_time !== undefined &&
      new Date(dto.start_time).getTime() <= Date.now()
    ) {
      throw new BadRequestException('start_time must be in the future');
    }

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
        added_by: userId,
        ...(g.position ? { position: g.position } : {}),
        // Mongoose casts the id strings on save, as with `user` above.
      } as unknown as GameDocument['participants'][number]);
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

    this.notifyStatusChange(game, prevStatus);
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

    // Guests leave with whoever brought them — they have no account of their
    // own, and only the host can remove a guest, so leaving them behind would
    // strand them on the roster taking up spots nobody can free. Dropped
    // outright rather than cancelled: unlike a player, a guest entry carries
    // no history worth keeping. Guests predating `added_by` can't be
    // attributed and so stay for the host to clear.
    for (let i = game.participants.length - 1; i >= 0; i--) {
      const p = game.participants[i];
      if (!p.user && p.added_by?.toString() === userId) {
        game.participants.splice(i, 1);
      }
    }

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
      added_by: userId,
      ...(position ? { position } : {}),
    } as unknown as GameDocument['participants'][number]);

    const prevStatus = game.status;
    this.recomputeStatus(game);
    const saved = await game.save();
    this.notifyStatusChange(saved, prevStatus);
    return saved;
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
    this.assertNotTerminal(game);

    const participant = game.participants[index];
    if (!participant || participant.user) {
      throw new BadRequestException('No guest at that position on the roster');
    }

    // The host manages the whole roster; anyone else may only take back a
    // guest they brought themselves. Guests predating `added_by` have no
    // owner on record, so they stay host-only.
    const isHost = game.host.toString() === userId;
    const broughtThem = participant.added_by?.toString() === userId;
    if (!isHost && !broughtThem) {
      throw new ForbiddenException(
        'Only the host or the player who added this guest can remove them',
      );
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
    const saved = await game.save();

    // Nudge every other joined participant to rate their teammates — the
    // host (who just took this action) doesn't need telling, but still gets
    // prompted for ratings client-side via GET /games/pending-ratings like
    // everyone else.
    const otherParticipants = saved.participants
      .filter((p) => p.status === ParticipantStatus.Joined && p.user && p.user.toString() !== userId)
      .map((p) => p.user!.toString());
    for (const participantId of otherParticipants) {
      this.notificationsService.sendToUser({
        userId: participantId,
        type: NotificationType.GameCompleted,
        title: 'Game completed',
        body: `Your ${saved.sport} game at ${saved.location} has ended — rate your teammates.`,
        gameId: saved.id,
      }).catch(() => {});
    }

    return saved;
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
   * Submit thumbs up/down ratings for the other players of a completed game.
   * The caller must have actually played (host or joined participant); ratees
   * who weren't joined participants (guests, non-participants, the caller
   * themselves) are silently dropped rather than rejected, since the client
   * only ever offers valid ratees anyway. One submission per caller per game —
   * a second attempt is rejected outright rather than allowed to overwrite.
   */
  async rateGame(id: string, callerId: string, dto: RateGameDto): Promise<GameDocument> {
    const validated = await validateDto(RateGameDto, dto);
    const game = await this.findByIdOrFail(id);

    if (game.status !== GameStatus.Completed) {
      throw new BadRequestException('Game is not completed yet');
    }
    const callerPlayed = game.participants.some(
      (p) => p.user?.toString() === callerId && p.status === ParticipantStatus.Joined,
    );
    if (!callerPlayed) {
      throw new BadRequestException('You did not play in this game');
    }
    if (game.rated_by.some((u) => u.toString() === callerId)) {
      throw new BadRequestException('You already rated this game');
    }

    const ratablePlayerIds = new Set(
      game.participants
        .filter((p) => p.status === ParticipantStatus.Joined && p.user && p.user.toString() !== callerId)
        .map((p) => p.user!.toString()),
    );

    for (const rating of validated.ratings) {
      if (!ratablePlayerIds.has(rating.user)) continue;
      await this.usersService.adjustReputation(rating.user, rating.value === 'up' ? 0.1 : -0.1);
    }

    game.rated_by.push(callerId as unknown as GameDocument['rated_by'][number]);
    return game.save();
  }

  /**
   * Completed games the caller played in (host or joined participant) but
   * hasn't submitted ratings for yet, most recently started first.
   */
  getPendingRatings(callerId: string): Promise<GameDocument[]> {
    return this.gameModel
      .find({
        status: GameStatus.Completed,
        rated_by: { $ne: callerId },
        participants: {
          $elemMatch: { user: callerId, status: ParticipantStatus.Joined },
        },
      })
      .sort({ start_time: -1 })
      .exec();
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

  /**
   * Notify every joined (registered) participant when a roster change flips
   * the game to `confirmed` or `locked` — called after ANY path that can
   * change the active headcount (`join`, `addGuest`, and `update` editing
   * min/max), not just `join`. Guests aren't notified (they have no account).
   */
  private notifyStatusChange(game: GameDocument, prevStatus: GameStatus): void {
    if (prevStatus === game.status) return;

    const activeParticipants = game.participants
      .filter((p) => p.status === ParticipantStatus.Joined && p.user)
      .map((p) => p.user!.toString());

    if (game.status === GameStatus.Confirmed) {
      for (const participantId of activeParticipants) {
        this.notificationsService.sendToUser({
          userId: participantId,
          type: NotificationType.GameConfirmed,
          title: 'Game confirmed!',
          body: `Your ${game.sport} game has enough players and is confirmed.`,
          gameId: game.id,
        }).catch(() => {});
      }
    } else if (game.status === GameStatus.Locked) {
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
}