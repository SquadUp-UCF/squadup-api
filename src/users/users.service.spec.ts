import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { User, AccountStatus } from './schemas/user.schema';

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
    create: jest.Mock;
  };

  beforeEach(async () => {
    model = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findOneAndUpdate: jest.fn(),
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
        reputation: 5,
        is_flaker: false,
        account_status: AccountStatus.Active,
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
});
