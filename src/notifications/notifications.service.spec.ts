import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from './schemas/notification.schema';

// Valid 24-char hex ids: the service coerces these to ObjectId, which throws on
// a malformed string, so the fixtures have to be real ObjectId hex.
const USER_ID = '507f1f77bcf86cd799439011';
const GAME_ID = '507f191e810c19729de860ea';
const NOTIF_ID = '507f1f77bcf86cd799439012';

/** Model method stub whose `.exec()` resolves to `result`. */
function execStub(result: unknown = undefined) {
  return { exec: jest.fn().mockResolvedValue(result) };
}

/** `find(...)` stub supporting the `.sort().limit().exec()` chain. */
function findStub(result: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let model: {
    create: jest.Mock;
    findOneAndUpdate: jest.Mock;
    find: jest.Mock;
    updateOne: jest.Mock;
    updateMany: jest.Mock;
    deleteOne: jest.Mock;
    deleteMany: jest.Mock;
  };

  beforeEach(async () => {
    model = {
      create: jest.fn().mockResolvedValue(undefined),
      findOneAndUpdate: jest.fn().mockReturnValue(execStub(null)),
      find: jest.fn(),
      updateOne: jest.fn().mockReturnValue(execStub()),
      updateMany: jest.fn().mockReturnValue(execStub()),
      deleteOne: jest.fn().mockReturnValue(execStub()),
      deleteMany: jest.fn().mockReturnValue(execStub()),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getModelToken(Notification.name), useValue: model },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);
  });

  describe('sendToUser', () => {
    it('collapses a game-scoped event into one unread row via an upsert', async () => {
      await service.sendToUser({
        userId: USER_ID,
        type: NotificationType.PlayerJoined,
        title: 'Someone joined',
        body: 'Bob joined your game',
        gameId: GAME_ID,
      });

      // Game-scoped events fold into the existing unread row instead of stacking.
      expect(model.create).not.toHaveBeenCalled();
      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);

      const [filter, update, options] = model.findOneAndUpdate.mock.calls[0];
      // Matched on user + type + game + unread, so a read row starts fresh and
      // events for a different user/game never collapse together.
      expect(filter.userId.toString()).toBe(USER_ID);
      expect(filter.gameId.toString()).toBe(GAME_ID);
      expect(filter.type).toBe(NotificationType.PlayerJoined);
      expect(filter.read).toBe(false);
      expect(options).toEqual(
        expect.objectContaining({ upsert: true, timestamps: false }),
      );
      // The upsert owns createdAt via $set (timestamps plugin off), so a fresh
      // insert still gets a timestamp.
      expect(update.$set.createdAt).toBeInstanceOf(Date);
      expect(update.$set.read).toBe(false);
    });

    it('creates a standalone row when the event has no gameId', async () => {
      await service.sendToUser({
        userId: USER_ID,
        type: NotificationType.GameCompleted,
        title: 'Game complete',
        body: 'Your game has finished',
      });

      // Nothing to collapse against without a game, so it never upserts.
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
      expect(model.create).toHaveBeenCalledTimes(1);

      const arg = model.create.mock.calls[0][0];
      expect(arg.userId.toString()).toBe(USER_ID);
      expect(arg.type).toBe(NotificationType.GameCompleted);
      expect(arg.gameId).toBeNull();
    });
  });

  describe('getForUser', () => {
    it("returns the user's 50 most recent notifications, newest first", async () => {
      const rows = [{ _id: 'n1' }, { _id: 'n2' }];
      const query = findStub(rows);
      model.find.mockReturnValue(query);

      const result = await service.getForUser(USER_ID);

      expect(result).toBe(rows);
      expect(model.find.mock.calls[0][0].userId.toString()).toBe(USER_ID);
      expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(query.limit).toHaveBeenCalledWith(50);
    });
  });

  describe('markRead', () => {
    it('marks a single notification read, scoped to its owner', async () => {
      await service.markRead(NOTIF_ID, USER_ID);

      const [filter, update] = model.updateOne.mock.calls[0];
      // The userId in the filter is what stops one user marking another's row.
      expect(filter._id).toBe(NOTIF_ID);
      expect(filter.userId.toString()).toBe(USER_ID);
      expect(update).toEqual({ read: true });
    });
  });

  describe('markAllRead', () => {
    it('marks every unread notification read for the user', async () => {
      await service.markAllRead(USER_ID);

      const [filter, update] = model.updateMany.mock.calls[0];
      expect(filter.userId.toString()).toBe(USER_ID);
      expect(filter.read).toBe(false);
      expect(update).toEqual({ read: true });
    });
  });

  describe('remove', () => {
    it('deletes a notification scoped to its owner so a foreign id cannot match', async () => {
      await service.remove(NOTIF_ID, USER_ID);

      expect(model.deleteOne).toHaveBeenCalledTimes(1);
      const filter = model.deleteOne.mock.calls[0][0];
      expect(filter._id).toBe(NOTIF_ID);
      expect(filter.userId.toString()).toBe(USER_ID);
    });

    it('treats an invalid notification id as a no-op instead of querying', async () => {
      await service.remove('not-an-object-id', USER_ID);

      expect(model.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('deletes every notification belonging to the user', async () => {
      await service.clearAll(USER_ID);

      expect(model.deleteMany).toHaveBeenCalledTimes(1);
      expect(model.deleteMany.mock.calls[0][0].userId.toString()).toBe(USER_ID);
    });
  });
});
