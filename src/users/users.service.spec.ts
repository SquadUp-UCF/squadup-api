import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { User, AccountStatus } from './schemas/user.schema';

// Avatar cleanup unlinks files; keep it off the real filesystem in unit tests.
jest.mock('node:fs/promises', () => ({
  unlink: jest.fn().mockResolvedValue(undefined),
}));
import { unlink } from 'node:fs/promises';

const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;

/** Build a chainable Mongoose query stub whose `.exec()` resolves to `result`. */
function queryStub(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let model: {
    findOne: jest.Mock;
    findById: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
    create: jest.Mock;
  };

  beforeEach(async () => {
    mockUnlink.mockClear();
    model = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      create: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getModelToken(User.name), useValue: model },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  const newUser = {
    first_name: 'Alex',
    last_name: 'Rivera',
    username: 'alex_r',
    email: 'alex@school.edu',
    password: 'hashed',
  };

  describe('create', () => {
    it('creates a user when email/username are free', async () => {
      model.findOne.mockReturnValue(queryStub(null));
      model.create.mockResolvedValue({ id: 'user-id', ...newUser });

      const result = await service.create(newUser);

      expect(model.create).toHaveBeenCalledWith(newUser);
      expect(result).toMatchObject({ id: 'user-id' });
    });

    it('throws 409 when email or username already exists', async () => {
      model.findOne.mockReturnValue(queryStub({ id: 'existing' }));
      await expect(service.create(newUser)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(model.create).not.toHaveBeenCalled();
    });
  });

  describe('findByEmail', () => {
    it('selects the password hash only when asked', async () => {
      const stub = queryStub({ id: 'user-id' });
      model.findOne.mockReturnValue(stub);

      await service.findByEmail('alex@school.edu', true);
      expect(stub.select).toHaveBeenCalledWith('+password');

      stub.select.mockClear();
      await service.findByEmail('alex@school.edu');
      expect(stub.select).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile', () => {
    it('throws 400 for an invalid field before touching the database', async () => {
      await expect(
        service.updateProfile('user-id', { username: 'ab' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.findOne).not.toHaveBeenCalled();
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('throws 409 when the new username is taken by another user', async () => {
      model.findOne.mockReturnValue(queryStub({ id: 'someone-else' }));
      await expect(
        service.updateProfile('user-id', { username: 'taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('updates and returns the user when valid', async () => {
      const updated = { id: 'user-id', first_name: 'Alexis' };
      model.findOneAndUpdate.mockReturnValue(queryStub(updated));

      const result = await service.updateProfile('user-id', {
        first_name: 'Alexis',
      });
      expect(result).toBe(updated);
    });

    it('throws 404 when the user is missing or deleted', async () => {
      model.findOneAndUpdate.mockReturnValue(queryStub(null));
      await expect(
        service.updateProfile('user-id', { first_name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softDelete', () => {
    it('stamps deleted_at when the user exists', async () => {
      model.findOneAndUpdate.mockReturnValue(queryStub({ id: 'user-id' }));
      await expect(service.softDelete('user-id')).resolves.toBeUndefined();
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'user-id', deleted_at: null },
        { deleted_at: expect.any(Date) },
      );
    });

    it('throws 404 when already deleted or missing', async () => {
      model.findOneAndUpdate.mockReturnValue(queryStub(null));
      await expect(service.softDelete('user-id')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('activatePendingByEmail', () => {
    it('only promotes pending, non-deleted accounts, so it cannot lift a suspension', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 1 }));
      await service.activatePendingByEmail('alex@ucf.edu');
      expect(model.updateOne).toHaveBeenCalledWith(
        {
          email: 'alex@ucf.edu',
          account_status: AccountStatus.Pending,
          deleted_at: null,
        },
        { account_status: AccountStatus.Active },
      );
    });
  });

  describe('updatePasswordByEmail', () => {
    it('stamps password_changed_at so a reset retires existing tokens', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 1 }));
      const before = Date.now();

      await service.updatePasswordByEmail('alex@ucf.edu', '$argon2id$hash');

      const [filter, update] = model.updateOne.mock.calls[0];
      expect(filter).toEqual({ email: 'alex@ucf.edu', deleted_at: null });
      expect(update.password).toBe('$argon2id$hash');
      expect(update.password_changed_at.getTime()).toBeGreaterThanOrEqual(
        before,
      );
    });

    it('refuses a soft-deleted account, so a stale link cannot revive it', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 0 }));

      await service.updatePasswordByEmail('gone@ucf.edu', '$argon2id$hash');

      expect(model.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ deleted_at: null }),
        expect.anything(),
      );
    });
  });

  describe('game membership helpers', () => {
    it('adds a hosted game with $addToSet', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 1 }));
      await service.addCreatedGame('user-id', 'game-id');
      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'user-id' },
        { $addToSet: { games_created: 'game-id' } },
      );
    });

    it('adds a joined game with $addToSet', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 1 }));
      await service.addJoinedGame('user-id', 'game-id');
      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'user-id' },
        { $addToSet: { games_joined: 'game-id' } },
      );
    });

    it('removes a joined game with $pull', async () => {
      model.updateOne.mockReturnValue(queryStub({ modifiedCount: 1 }));
      await service.removeJoinedGame('user-id', 'game-id');
      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'user-id' },
        { $pull: { games_joined: 'game-id' } },
      );
    });
  });

  describe('getPublicProfile', () => {
    it('returns only non-sensitive fields for an active user', async () => {
      model.findOne.mockReturnValue(
        queryStub({
          id: 'user-id',
          first_name: 'Alex',
          last_name: 'Rivera',
          username: 'alex_r',
          email: 'alex@school.edu',
          password: 'hashed',
          profile_picture: '/uploads/avatars/alex.jpg',
          reputation: 5,
          is_flaker: false,
          account_status: AccountStatus.Active,
          preferred_positions: new Map([['soccer', 'GK']]),
          games_created: ['a', 'b'],
          games_joined: ['c'],
        }),
      );

      const result = await service.getPublicProfile('user-id');

      expect(result).toEqual({
        id: 'user-id',
        first_name: 'Alex',
        last_name: 'Rivera',
        username: 'alex_r',
        profile_picture: '/uploads/avatars/alex.jpg',
        reputation: 5,
        is_flaker: false,
        account_status: AccountStatus.Active,
        skill_levels: {},
        preferred_positions: { soccer: 'GK' },
        games_created: 2,
        games_joined: 1,
      });
      expect(result).not.toHaveProperty('email');
      expect(result).not.toHaveProperty('password');
    });

    it('throws 404 when the user does not exist or is deleted', async () => {
      model.findOne.mockReturnValue(queryStub(null));
      await expect(service.getPublicProfile('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setProfilePicture', () => {
    const newPath = '/uploads/avatars/new.jpg';

    it('stores the new path and deletes the file it replaces', async () => {
      model.findOne.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: '/uploads/avatars/old.png' }),
      );
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: newPath }),
      );

      const result = await service.setProfilePicture('user-id', newPath);

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'user-id', deleted_at: null },
        { profile_picture: newPath },
        { new: true },
      );
      expect(result.profile_picture).toBe(newPath);
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('old.png'));
    });

    it('does not unlink anything when the user had no previous picture', async () => {
      model.findOne.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: null }),
      );
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: newPath }),
      );

      await service.setProfilePicture('user-id', newPath);

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('cleans up the orphaned upload and 404s when the user is gone', async () => {
      model.findOne.mockReturnValue(queryStub(null));

      await expect(
        service.setProfilePicture('missing', newPath),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('new.jpg'));
    });
  });

  describe('removeProfilePicture', () => {
    it('clears the field and deletes the stored file', async () => {
      model.findOne.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: '/uploads/avatars/old.png' }),
      );
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: null }),
      );

      const result = await service.removeProfilePicture('user-id');

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'user-id', deleted_at: null },
        { profile_picture: null },
        { new: true },
      );
      expect(result.profile_picture).toBeNull();
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('old.png'));
    });

    it('is a no-op unlink when there is no picture to remove', async () => {
      model.findOne.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: null }),
      );
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', profile_picture: null }),
      );

      await service.removeProfilePicture('user-id');

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('throws 404 when the user does not exist or is deleted', async () => {
      model.findOne.mockReturnValue(queryStub(null));

      await expect(
        service.removeProfilePicture('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('saved games', () => {
    const gameId = '507f1f77bcf86cd799439011';

    it('saves a game with $addToSet and returns the updated user', async () => {
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', saved_games: [gameId] }),
      );

      const result = await service.saveGame('user-id', gameId);

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'user-id', deleted_at: null },
        { $addToSet: { saved_games: gameId } },
        { new: true },
      );
      expect(result.saved_games).toContain(gameId);
    });

    it('unsaves a game with $pull', async () => {
      model.findOneAndUpdate.mockReturnValue(
        queryStub({ id: 'user-id', saved_games: [] }),
      );

      await service.unsaveGame('user-id', gameId);

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'user-id', deleted_at: null },
        { $pull: { saved_games: gameId } },
        { new: true },
      );
    });

    it('rejects an invalid game id before touching the database', async () => {
      await expect(service.saveGame('user-id', 'nope')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('throws 404 when saving for a missing/deleted user', async () => {
      model.findOneAndUpdate.mockReturnValue(queryStub(null));
      await expect(service.saveGame('gone', gameId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lists saved games newest-first and drops deleted ones', async () => {
      const populated = {
        saved_games: [{ id: 'a' }, null, { id: 'b' }],
      };
      model.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(populated),
      });

      const result = await service.getSavedGames('user-id');

      expect(result).toEqual([{ id: 'b' }, { id: 'a' }]);
    });
  });
});
