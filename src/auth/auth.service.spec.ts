import { Test } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { AccountStatus } from '../users/schemas/user.schema';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: { create: jest.Mock; findByEmail: jest.Mock };
  let jwtService: { sign: jest.Mock };

  beforeEach(async () => {
    usersService = { create: jest.fn(), findByEmail: jest.fn() };
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  const registerDto = {
    first_name: 'Alex',
    last_name: 'Rivera',
    username: 'alex_r',
    email: 'alex@school.edu',
    password: 'password123',
  };

  describe('register', () => {
    it('hashes the password with Argon2id and returns a token + user', async () => {
      usersService.create.mockImplementation(async (data) => ({
        id: 'user-id',
        first_name: data.first_name,
        last_name: data.last_name,
        username: data.username,
      }));

      const result = await service.register(registerDto);

      // The hash handed to the persistence layer must be Argon2id, not plaintext.
      const created = usersService.create.mock.calls[0][0];
      expect(created.password).not.toBe(registerDto.password);
      expect(created.password.startsWith('$argon2id$')).toBe(true);

      expect(result).toEqual({
        token: 'signed.jwt.token',
        user: { id: 'user-id', name: 'Alex Rivera', username: 'alex_r' },
      });
      expect(jwtService.sign).toHaveBeenCalledWith({ sub: 'user-id' });
    });
  });

  describe('login', () => {
    const loginDto = { email: 'alex@school.edu', password: 'password123' };

    const buildUser = async (overrides = {}) => ({
      id: 'user-id',
      first_name: 'Alex',
      last_name: 'Rivera',
      username: 'alex_r',
      password: await argon2.hash(loginDto.password, { type: argon2.argon2id }),
      account_status: AccountStatus.Active,
      deleted_at: null,
      ...overrides,
    });

    it('returns a token + user for valid credentials', async () => {
      usersService.findByEmail.mockResolvedValue(await buildUser());

      const result = await service.login(loginDto);

      expect(usersService.findByEmail).toHaveBeenCalledWith(loginDto.email, true);
      expect(result.token).toBe('signed.jwt.token');
      expect(result.user).toEqual({
        id: 'user-id',
        name: 'Alex Rivera',
        username: 'alex_r',
      });
    });

    it('rejects an unknown email with 401', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      await expect(service.login(loginDto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password with 401', async () => {
      usersService.findByEmail.mockResolvedValue(await buildUser());
      await expect(
        service.login({ ...loginDto, password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a soft-deleted account with 401', async () => {
      usersService.findByEmail.mockResolvedValue(
        await buildUser({ deleted_at: new Date() }),
      );
      await expect(service.login(loginDto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a suspended account with 403', async () => {
      usersService.findByEmail.mockResolvedValue(
        await buildUser({ account_status: AccountStatus.Suspended }),
      );
      await expect(service.login(loginDto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
