import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GamesService } from './games.service';
import { Game, GameStatus, ParticipantStatus } from './schemas/game.schema';
import { UsersService } from '../users/users.service';

/** Query stub whose `.exec()` resolves to `result`; `.sort()` chains. */
function queryStub(result: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

/** Build a fake hydrated game with a `save()` that resolves to itself. */
function makeGame(overrides: Record<string, any> = {}) {
  const game: any = {
    id: 'game-id',
    host: 'host-id',
    sport: 'soccer',
    location: 'Field 2',
    start_time: new Date(Date.now() + 60 * 60 * 1000),
    latitude: 40,
    longitude: -74,
    min_players: 2,
    max_players: 3,
    status: GameStatus.Open,
    participants: [
      { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
    ],
    ...overrides,
  };
  game.save = jest.fn().mockResolvedValue(game);
  return game;
}

const validCreate = {
  sport: 'soccer',
  location: 'North Campus Field 2',
  start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  latitude: 40.7128,
  longitude: -74.006,
  min_players: 2,
  max_players: 4,
};

describe('GamesService', () => {
  let service: GamesService;
  let model: { create: jest.Mock; findById: jest.Mock; find: jest.Mock };
  let users: {
    addCreatedGame: jest.Mock;
    addJoinedGame: jest.Mock;
    removeJoinedGame: jest.Mock;
  };

  beforeEach(async () => {
    model = { create: jest.fn(), findById: jest.fn(), find: jest.fn() };
    users = {
      addCreatedGame: jest.fn().mockResolvedValue(undefined),
      addJoinedGame: jest.fn().mockResolvedValue(undefined),
      removeJoinedGame: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamesService,
        { provide: getModelToken(Game.name), useValue: model },
        { provide: UsersService, useValue: users },
      ],
    }).compile();

    service = moduleRef.get(GamesService);
  });

  describe('create', () => {
    it('auto-adds the host to the roster and records the game on their profile', async () => {
      model.create.mockResolvedValue(makeGame());

      await service.create('host-id', validCreate);

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'host-id',
          participants: [
            { user: 'host-id', status: ParticipantStatus.Joined },
          ],
        }),
      );
      expect(users.addCreatedGame).toHaveBeenCalledWith('host-id', 'game-id');
    });

    it('rejects min_players greater than max_players', async () => {
      await expect(
        service.create('host-id', { ...validCreate, min_players: 5, max_players: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.create).not.toHaveBeenCalled();
    });

    it('rejects a start_time in the past', async () => {
      await expect(
        service.create('host-id', {
          ...validCreate,
          start_time: new Date(Date.now() - 1000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.create).not.toHaveBeenCalled();
    });
  });

  describe('findMany', () => {
    it('filters by sport/status and defaults to upcoming games', async () => {
      const stub = queryStub([]);
      model.find.mockReturnValue(stub);

      await service.findMany({ sport: 'soccer', status: GameStatus.Open });

      expect(model.find).toHaveBeenCalledWith({
        sport: 'soccer',
        status: GameStatus.Open,
        start_time: { $gt: expect.any(Date) },
      });
    });

    it('omits the upcoming filter when upcoming is false', async () => {
      const stub = queryStub([]);
      model.find.mockReturnValue(stub);

      await service.findMany({ upcoming: false });

      expect(model.find).toHaveBeenCalledWith({});
    });
  });

  describe('join', () => {
    it('promotes to confirmed then locked as the roster fills', async () => {
      const game = makeGame(); // min 2, max 3, host already joined (1)
      model.findById.mockReturnValue(queryStub(game));

      await service.join('game-id', 'u2');
      expect(game.status).toBe(GameStatus.Confirmed);
      expect(users.addJoinedGame).toHaveBeenCalledWith('u2', 'game-id');

      await service.join('game-id', 'u3');
      expect(game.status).toBe(GameStatus.Locked);
    });

    it('rejects joining a full (locked) game', async () => {
      const game = makeGame({ status: GameStatus.Locked });
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.join('game-id', 'u2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects joining a cancelled game', async () => {
      const game = makeGame({ status: GameStatus.Cancelled });
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.join('game-id', 'u2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects joining after the game has started', async () => {
      const game = makeGame({ start_time: new Date(Date.now() - 1000) });
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.join('game-id', 'u2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects joining twice', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.join('game-id', 'host-id')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('revives a previously cancelled roster entry on re-join', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'u2', status: ParticipantStatus.Cancelled, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.join('game-id', 'u2');

      expect(game.participants).toHaveLength(2);
      expect(game.participants[1].status).toBe(ParticipantStatus.Joined);
    });
  });

  describe('leave', () => {
    it('marks the participant cancelled, recomputes, and updates the profile', async () => {
      const game = makeGame({
        status: GameStatus.Confirmed,
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'u2', status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.leave('game-id', 'u2');

      expect(game.participants[1].status).toBe(ParticipantStatus.Cancelled);
      expect(game.status).toBe(GameStatus.Open); // dropped below min_players (2)
      expect(users.removeJoinedGame).toHaveBeenCalledWith('u2', 'game-id');
    });

    it('forbids the host from leaving', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.leave('game-id', 'host-id')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a user who is not on the roster', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.leave('game-id', 'stranger')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects leaving a terminal game', async () => {
      const game = makeGame({ status: GameStatus.Completed });
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.leave('game-id', 'u2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('update', () => {
    it('forbids a non-host', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.update('game-id', 'someone-else', { location: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects edits to a terminal game', async () => {
      const game = makeGame({ status: GameStatus.Cancelled });
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.update('game-id', 'host-id', { location: 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an edit where min_players exceeds max_players', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.update('game-id', 'host-id', { min_players: 9 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('applies a valid edit and saves', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await service.update('game-id', 'host-id', { location: 'New Field' });
      expect(game.location).toBe('New Field');
      expect(game.save).toHaveBeenCalled();
    });
  });

  describe('cancel / complete', () => {
    it('lets the host cancel', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await service.cancel('game-id', 'host-id');
      expect(game.status).toBe(GameStatus.Cancelled);
    });

    it('lets the host complete', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await service.complete('game-id', 'host-id');
      expect(game.status).toBe(GameStatus.Completed);
    });

    it('forbids a non-host from cancelling', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.cancel('game-id', 'x')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects completing an already-terminal game', async () => {
      const game = makeGame({ status: GameStatus.Cancelled });
      model.findById.mockReturnValue(queryStub(game));
      await expect(service.complete('game-id', 'host-id')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
