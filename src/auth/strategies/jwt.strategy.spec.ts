import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../../users/users.service';
import { AccountStatus } from '../../users/schemas/user.schema';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: { findActiveById: jest.Mock };

  /** Seconds since the epoch, the unit `iat` is expressed in. */
  const secs = (ms: number) => Math.floor(ms / 1000);
  const now = Date.now();

  const activeUser = {
    account_status: AccountStatus.Active,
    password_changed_at: null,
  };

  beforeEach(async () => {
    usersService = { findActiveById: jest.fn().mockResolvedValue(activeUser) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: UsersService, useValue: usersService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-secret') },
        },
      ],
    }).compile();

    strategy = moduleRef.get(JwtStrategy);
  });

  it('accepts a token for an active user who has never reset', async () => {
    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now) }),
    ).resolves.toBe(activeUser);
  });

  it('rejects a token for a soft-deleted (or missing) user', async () => {
    usersService.findActiveById.mockResolvedValue(null);
    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now) }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token issued before the last password reset', async () => {
    usersService.findActiveById.mockResolvedValue({
      account_status: AccountStatus.Active,
      password_changed_at: new Date(now),
    });

    // The stolen token predates the reset, so the reset must kill it.
    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now - 60_000) }),
    ).rejects.toThrow('Password was changed. Please log in again.');
  });

  it('accepts a token issued after the last password reset', async () => {
    const user = {
      account_status: AccountStatus.Active,
      password_changed_at: new Date(now),
    };
    usersService.findActiveById.mockResolvedValue(user);

    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now + 60_000) }),
    ).resolves.toBe(user);
  });

  it('rejects a pending account', async () => {
    usersService.findActiveById.mockResolvedValue({
      account_status: AccountStatus.Pending,
      password_changed_at: null,
    });
    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now) }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a suspended account', async () => {
    usersService.findActiveById.mockResolvedValue({
      account_status: AccountStatus.Suspended,
      password_changed_at: null,
    });
    await expect(
      strategy.validate({ sub: 'user-id', iat: secs(now) }),
    ).rejects.toThrow('Account suspended');
  });
});
