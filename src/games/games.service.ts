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
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { ListGamesDto } from './dto/list-games.dto';
import { MyGamesDto, MyGamesRole } from './dto/my-games.dto';
import { validateDto } from '../common/validation/validate-dto';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';

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
      participants: [{ user: hostId, status: ParticipantStatus.Joined }],
    });

    await this.usersService.addCreatedGame(hostId, game.id);
    return game;
  }

  /** Discovery listing. Filters by sport, status, and (by default) upcoming. */
  findMany(filters: ListGamesDto): Promise<GameDocument[]> {
    const query: Record<string, unknown> = {};
    if (filters.sport) {
      query.sport = filters.sport;
    }
    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.upcoming !== false) {
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

    Object.assign(game, dto);

    if (game.min_players > game.max_players) {
      throw new BadRequestException('min_players cannot exceed max_players');
    }

    this.recomputeStatus(game);
    return game.save();
  }

  async join(id: string, userId: string): Promise<GameDocument> {
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
    if (existing) {
      existing.status = ParticipantStatus.Joined;
      existing.joined_at = new Date();
    } else {
      game.participants.push({
        user: userId as unknown as GameDocument['participants'][number]['user'],
        status: ParticipantStatus.Joined,
        joined_at: new Date(),
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

  private recomputeStatus(game: GameDocument): void {
    if (this.isTerminal(game)) {
      return;
    }
    const active = game.participants.filter(
      (p) => p.status === ParticipantStatus.Joined,
    ).length;

    if (active >= game.max_players) {
      game.status = GameStatus.Locked;
    } else if (active >= game.min_players) {
      game.status = GameStatus.Confirmed;
    } else {
      game.status = GameStatus.Open;
    }
  }
}