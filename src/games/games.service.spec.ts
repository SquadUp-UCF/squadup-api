import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GamesService } from './games.service';
import { Game, GameSkillLevel, GameStatus, ParticipantStatus } from './schemas/game.schema';
import { MyGamesRole } from './dto/my-games.dto';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { bannerForSport } from './sport-banners';

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
    rated_by: [],
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
    adjustReputation: jest.Mock;
  };
  let notifications: { sendToUser: jest.Mock };

  beforeEach(async () => {
    model = { create: jest.fn(), findById: jest.fn(), find: jest.fn() };
    users = {
      addCreatedGame: jest.fn().mockResolvedValue(undefined),
      addJoinedGame: jest.fn().mockResolvedValue(undefined),
      removeJoinedGame: jest.fn().mockResolvedValue(undefined),
      adjustReputation: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { sendToUser: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamesService,
        { provide: getModelToken(Game.name), useValue: model },
        { provide: UsersService, useValue: users },
        { provide: NotificationsService, useValue: notifications },
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

    it("defaults photo_url to the sport's stock banner when none is given", async () => {
      model.create.mockResolvedValue(makeGame());

      await service.create('host-id', validCreate);

      // Asserted through the resolver, not a literal path: which file backs a
      // sport (.jpg vs the .svg placeholder) is an asset detail, and the rule
      // under test is only "it defaults to that sport's stock banner".
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ photo_url: bannerForSport('soccer') }),
      );
    });

    it('keeps a host-supplied banner instead of the stock one', async () => {
      model.create.mockResolvedValue(makeGame());

      await service.create('host-id', {
        ...validCreate,
        photo_url: 'https://cdn.squadup.app/games/abc.jpg',
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          photo_url: 'https://cdn.squadup.app/games/abc.jpg',
        }),
      );
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

    it('pre-adds initial guest players by name and recomputes status', async () => {
      // validCreate is min 2 / max 4; host + 1 guest = 2 → confirmed.
      const created = makeGame({
        max_players: 4,
        status: GameStatus.Open,
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { name: 'Sam Lee', status: ParticipantStatus.Joined },
        ],
      });
      model.create.mockResolvedValue(created);

      await service.create('host-id', { ...validCreate, players: [{ name: 'Sam Lee' }] });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [
            { user: 'host-id', status: ParticipantStatus.Joined },
            { name: 'Sam Lee', status: ParticipantStatus.Joined },
          ],
        }),
      );
      expect(created.status).toBe(GameStatus.Confirmed);
      expect(created.save).toHaveBeenCalled();
    });

    it('pre-adds a guest with a sport-specific position', async () => {
      const created = makeGame({
        max_players: 4,
        status: GameStatus.Open,
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { name: 'Sam Lee', position: 'Goalkeeper', status: ParticipantStatus.Joined },
        ],
      });
      model.create.mockResolvedValue(created);

      await service.create('host-id', {
        ...validCreate,
        players: [{ name: 'Sam Lee', position: 'Goalkeeper' }],
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [
            { user: 'host-id', status: ParticipantStatus.Joined },
            { name: 'Sam Lee', status: ParticipantStatus.Joined, position: 'Goalkeeper' },
          ],
        }),
      );
    });

    it('ignores blank guest names (host only, no roster seeding)', async () => {
      model.create.mockResolvedValue(makeGame());

      await service.create('host-id', { ...validCreate, players: [{ name: '  ' }, { name: '' }] });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [{ user: 'host-id', status: ParticipantStatus.Joined }],
        }),
      );
    });

    it('rejects more initial players than the max roster allows', async () => {
      await expect(
        service.create('host-id', {
          ...validCreate,
          max_players: 2,
          players: [{ name: 'Sam' }, { name: 'Alex' }], // host + 2 = 3 > max 2
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.create).not.toHaveBeenCalled();
    });

    it("sets the host's own position when provided", async () => {
      model.create.mockResolvedValue(makeGame());

      await service.create('host-id', { ...validCreate, host_position: 'Midfielder' });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [
            { user: 'host-id', status: ParticipantStatus.Joined, position: 'Midfielder' },
          ],
        }),
      );
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

    it('by default keeps games until 4h past start and hides ended ones', async () => {
      const stub = queryStub([]);
      model.find.mockReturnValue(stub);

      const before = Date.now();
      await service.findMany({});
      const after = Date.now();

      expect(model.find).toHaveBeenCalledTimes(1);
      const arg = model.find.mock.calls[0][0];
      // Cutoff is ~4h in the past (start_time must be after it).
      const cutoff = (arg.start_time as { $gt: Date }).$gt.getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before - 4 * 60 * 60 * 1000 - 5);
      expect(cutoff).toBeLessThanOrEqual(after - 4 * 60 * 60 * 1000 + 5);
      expect(arg.status).toEqual({
        $nin: [GameStatus.Completed, GameStatus.Cancelled],
      });
    });

    it('filters by skill_level when provided', async () => {
      const stub = queryStub([]);
      model.find.mockReturnValue(stub);

      await service.findMany({ skill_level: GameSkillLevel.Beginner, upcoming: false });

      expect(model.find).toHaveBeenCalledWith({
        skill_level: GameSkillLevel.Beginner,
      });
    });
  });

  describe('findForUser', () => {
    const hosting = { host: 'me' };
    const playing = {
      participants: {
        $elemMatch: { user: 'me', status: ParticipantStatus.Joined },
      },
    };

    it('defaults to games the user hosts or actively plays in', async () => {
      const stub = queryStub([]);
      model.find.mockReturnValue(stub);

      await service.findForUser('me', {});

      expect(model.find).toHaveBeenCalledWith({ $or: [hosting, playing] });
      expect(stub.sort).toHaveBeenCalledWith({ start_time: 1 });
    });

    it('narrows to hosted games when role=hosting', async () => {
      model.find.mockReturnValue(queryStub([]));
      await service.findForUser('me', { role: MyGamesRole.Hosting });
      expect(model.find).toHaveBeenCalledWith(hosting);
    });

    it('narrows to played games when role=playing', async () => {
      model.find.mockReturnValue(queryStub([]));
      await service.findForUser('me', { role: MyGamesRole.Playing });
      expect(model.find).toHaveBeenCalledWith(playing);
    });

    it('applies a status filter alongside involvement', async () => {
      model.find.mockReturnValue(queryStub([]));
      await service.findForUser('me', { status: GameStatus.Completed });
      expect(model.find).toHaveBeenCalledWith({
        $or: [hosting, playing],
        status: GameStatus.Completed,
      });
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

    it('defaults party_size to 1 when none is given', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));

      await service.join('game-id', 'u2');

      expect(game.participants[1].party_size).toBe(1);
    });

    it("counts a party's full headcount toward min/max instead of 1 per join", async () => {
      // min 2, max 3, host already in (1) — a party of 2 fills the rest.
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));

      await service.join('game-id', 'u2', { party_size: 2 });

      expect(game.participants[1].party_size).toBe(2);
      expect(game.status).toBe(GameStatus.Locked);
    });

    it("rejects a party too large for the remaining spots", async () => {
      // min 2, max 3, host already in (1) — only 2 spots remain.
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));

      await expect(
        service.join('game-id', 'u2', { party_size: 3 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(game.participants).toHaveLength(1); // nothing was added
    });

    it('rejects a party_size below 1', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));

      await expect(
        service.join('game-id', 'u2', { party_size: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
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

  describe('guests', () => {
    it('lets the host add a guest with a position and recomputes status', async () => {
      // min 2, max 4, host only (1) — adding one guest reaches min → confirmed.
      const game = makeGame({ max_players: 4 });
      model.findById.mockReturnValue(queryStub(game));

      await service.addGuest('game-id', 'host-id', {
        name: 'Sam Lee',
        position: 'Goalkeeper',
      });

      expect(game.participants).toHaveLength(2);
      expect(game.participants[1]).toMatchObject({
        name: 'Sam Lee',
        position: 'Goalkeeper',
        status: ParticipantStatus.Joined,
      });
      expect(game.status).toBe(GameStatus.Confirmed);
      expect(game.save).toHaveBeenCalled();
    });

    it('forbids a non-host from adding a guest', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.addGuest('game-id', 'stranger', { name: 'Sam' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects adding a guest to a full roster', async () => {
      // max 3, host + 2 already joined → no room.
      const game = makeGame({
        max_players: 3,
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { user: 'u2', status: ParticipantStatus.Joined },
          { name: 'G1', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.addGuest('game-id', 'host-id', { name: 'Late' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the host remove a guest by index', async () => {
      const game = makeGame({
        max_players: 4,
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { name: 'Sam Lee', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.removeGuest('game-id', 'host-id', 1);

      expect(game.participants).toHaveLength(1);
      expect(game.participants[0].user).toBe('host-id');
      expect(game.save).toHaveBeenCalled();
    });

    it('refuses to remove a registered player via the guest endpoint', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { user: 'u2', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.removeGuest('game-id', 'host-id', 1),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('forbids a non-host from removing a guest', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { name: 'Sam', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.removeGuest('game-id', 'stranger', 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('setMyPosition', () => {
    it("sets the caller's own position", async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined },
          { user: 'u2', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.setMyPosition('game-id', 'u2', { position: 'Forward' });

      expect(game.participants[1].position).toBe('Forward');
      expect(game.save).toHaveBeenCalled();
    });

    it('clears the position when sent empty', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', position: 'GK', status: ParticipantStatus.Joined },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.setMyPosition('game-id', 'host-id', { position: '' });

      expect(game.participants[0].position).toBeUndefined();
    });

    it('rejects a caller who is not on the roster', async () => {
      const game = makeGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.setMyPosition('game-id', 'stranger', { position: 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
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

    it('re-points a stock banner when the sport changes', async () => {
      const game = makeGame({ photo_url: bannerForSport('soccer') });
      model.findById.mockReturnValue(queryStub(game));
      await service.update('game-id', 'host-id', { sport: 'tennis' });
      expect(game.photo_url).toBe(bannerForSport('tennis'));
    });

    it('keeps a custom banner even when the sport changes', async () => {
      const custom = 'https://cdn.squadup.app/games/abc.jpg';
      const game = makeGame({ photo_url: custom });
      model.findById.mockReturnValue(queryStub(game));
      await service.update('game-id', 'host-id', { sport: 'tennis' });
      expect(game.photo_url).toBe(custom);
    });

    it('notifies the roster (but not the editing host) when the time changes', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'player-1', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'player-2', status: ParticipantStatus.Cancelled, joined_at: new Date() },
          { name: 'Guest', status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.update('game-id', 'host-id', {
        start_time: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
      });

      // Only the joined, registered, non-host player is reachable.
      expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
      expect(notifications.sendToUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'player-1',
          type: NotificationType.GameUpdated,
          gameId: 'game-id',
          body: 'The soccer game you joined changed its time.',
        }),
      );
    });

    it('names every changed detail in one notification', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'player-1', status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.update('game-id', 'host-id', {
        start_time: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
        location: 'Field 7',
        sport: 'tennis',
      });

      expect(notifications.sendToUser).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'The soccer game you joined changed its time, location and sport.',
        }),
      );
    });

    it('stays quiet when the edit only touches cosmetic fields', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'player-1', status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.update('game-id', 'host-id', { description: 'Bring water' });

      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });

    it('stays quiet when an edit re-sends the same values', async () => {
      const game = makeGame({
        participants: [
          { user: 'host-id', status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: 'player-1', status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
      });
      model.findById.mockReturnValue(queryStub(game));

      await service.update('game-id', 'host-id', {
        location: game.location,
        sport: game.sport,
        start_time: game.start_time.toISOString(),
      });

      expect(notifications.sendToUser).not.toHaveBeenCalled();
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

  describe('rateGame', () => {
    // Ratee ids must be valid ObjectIds (the DTO enforces @IsMongoId).
    const HOST = '507f1f77bcf86cd799439011';
    const U2 = '507f1f77bcf86cd799439012';
    const STRANGER = '507f1f77bcf86cd799439013';
    const completedGame = () =>
      makeGame({
        host: HOST,
        status: GameStatus.Completed,
        participants: [
          { user: HOST, status: ParticipantStatus.Joined, joined_at: new Date() },
          { user: U2, status: ParticipantStatus.Joined, joined_at: new Date() },
        ],
        rated_by: [],
      });

    it('records the rater and adjusts the ratee reputation', async () => {
      const game = completedGame();
      model.findById.mockReturnValue(queryStub(game));

      await service.rateGame('game-id', U2, { ratings: [{ user: HOST, value: 'up' }] });

      expect(users.adjustReputation).toHaveBeenCalledWith(HOST, 0.1);
      expect(game.rated_by).toContain(U2);
      expect(game.save).toHaveBeenCalled();
    });

    it('rejects rating a game that is not completed', async () => {
      const game = makeGame({ status: GameStatus.Open });
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.rateGame('game-id', 'host-id', { ratings: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('forbids a non-participant from rating', async () => {
      const game = completedGame();
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.rateGame('game-id', STRANGER, { ratings: [] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects rating the same game twice', async () => {
      const game = completedGame();
      game.rated_by = [U2];
      model.findById.mockReturnValue(queryStub(game));
      await expect(
        service.rateGame('game-id', U2, { ratings: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ignores ratings for players not in the game', async () => {
      const game = completedGame();
      model.findById.mockReturnValue(queryStub(game));
      await service.rateGame('game-id', U2, { ratings: [{ user: STRANGER, value: 'down' }] });
      expect(users.adjustReputation).not.toHaveBeenCalled();
      expect(game.rated_by).toContain(U2);
    });
  });
});
