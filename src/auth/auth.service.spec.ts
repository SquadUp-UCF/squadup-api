import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PwnedPasswordService } from './pwned-password.service';
import { AccountStatus } from '../users/schemas/user.schema';
import { EmailVerification } from './schemas/email-verification.schema';
import { PasswordReset } from './schemas/password-reset.schema';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    create: jest.Mock;
    findByEmail: jest.Mock;
    findById: jest.Mock;
    activatePendingByEmail: jest.Mock;
    updatePasswordByEmail: jest.Mock;
    updatePasswordById: jest.Mock;
  };
  let jwtService: { sign: jest.Mock };
  let pwnedPasswordService: { isPwned: jest.Mock };
  let emailVerificationModel: {
    findOne: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  let passwordResetModel: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  let resend: { emails: { send: jest.Mock } };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    usersService = {
      create: jest.fn(),
      findByEmail: jest.fn(),
      findById: jest.fn(),
      activatePendingByEmail: jest.fn(),
      updatePasswordByEmail: jest.fn().mockResolvedValue(undefined),
      updatePasswordById: jest.fn().mockResolvedValue(undefined),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    // Default: password is not breached; individual tests override as needed.
    pwnedPasswordService = { isPwned: jest.fn().mockResolvedValue(false) };
    emailVerificationModel = {
      findOne: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    passwordResetModel = {
      findOne: jest.fn().mockResolvedValue(null),
      // Default: the token is claimed successfully (nobody raced us).
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    resend = { emails: { send: jest.fn().mockResolvedValue({}) } };
    configService = { get: jest.fn().mockReturnValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: PwnedPasswordService, useValue: pwnedPasswordService },
        { provide: ConfigService, useValue: configService },
        {
          provide: getModelToken(EmailVerification.name),
          useValue: emailVerificationModel,
        },
        {
          provide: getModelToken(PasswordReset.name),
          useValue: passwordResetModel,
        },
        { provide: 'RESEND', useValue: resend },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  const registerDto = {
    first_name: 'Alex',
    last_name: 'Rivera',
    username: 'alex_r',
    email: 'alex@ucf.edu',
    password: 'Passw0rd!',
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

    it('rejects an invalid payload with 400 before hashing or persisting', async () => {
      await expect(
        service.register({ ...registerDto, email: 'not-an-email' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('rejects unknown properties in the payload with 400', async () => {
      await expect(
        service.register({ ...registerDto, is_admin: true } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    // Registration is restricted to UCF email addresses (@ucf.edu).
    it.each([
      'alex@gmail.com',
      'alex@knights.ucf.edu',
      'alex@ucf.edu.evil.com',
      'alex@notucf.edu',
    ])('rejects a non-UCF email (%s) with 400', async (email) => {
      await expect(
        service.register({ ...registerDto, email }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('accepts a @ucf.edu email regardless of case', async () => {
      usersService.create.mockResolvedValue({
        id: 'user-id',
        first_name: 'Alex',
        last_name: 'Rivera',
        username: 'alex_r',
      });
      await expect(
        service.register({ ...registerDto, email: 'Alex@UCF.EDU' }),
      ).resolves.toHaveProperty('token');
    });

    // Policy: 8–20 chars, >=1 uppercase, >=1 lowercase, >=1 number, >=1 symbol.
    it.each([
      ['too short', 'Ab1!xy'],
      ['too long', 'Abcdefg1!Abcdefg1!ABC'],
      ['no uppercase', 'passw0rd!'],
      ['no lowercase', 'PASSW0RD!'],
      ['no number', 'Password!'],
      ['no symbol', 'Password1'],
    ])(
      'rejects a password that is %s with 400 before hashing or persisting',
      async (_label, password) => {
        await expect(
          service.register({ ...registerDto, password }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(usersService.create).not.toHaveBeenCalled();
      },
    );

    it('accepts a policy-compliant password', async () => {
      usersService.create.mockResolvedValue({
        id: 'user-id',
        first_name: 'Alex',
        last_name: 'Rivera',
        username: 'alex_r',
      });
      await expect(
        service.register({ ...registerDto, password: 'Str0ng#Pass' }),
      ).resolves.toHaveProperty('token');
    });

    it('rejects a breached password with 400 without persisting', async () => {
      pwnedPasswordService.isPwned.mockResolvedValue(true);
      await expect(service.register(registerDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(pwnedPasswordService.isPwned).toHaveBeenCalledWith(
        registerDto.password,
      );
      expect(usersService.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const loginDto = { email: 'alex@ucf.edu', password: 'password123' };

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

    it('rejects a pending (unverified) account with 401', async () => {
      usersService.findByEmail.mockResolvedValue(
        await buildUser({ account_status: AccountStatus.Pending }),
      );
      await expect(service.login(loginDto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('sendVerificationCode', () => {
    const email = 'alex@ucf.edu';

    it.each(['alex@gmail.com', 'not-an-email', ''])(
      'rejects an invalid or non-UCF email (%s) with 400 without sending',
      async (badEmail) => {
        await expect(
          service.sendVerificationCode({ email: badEmail }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(emailVerificationModel.create).not.toHaveBeenCalled();
        expect(resend.emails.send).not.toHaveBeenCalled();
      },
    );

    it('rejects with 429 during the per-email cooldown without sending', async () => {
      // A code for this email was created moments ago.
      emailVerificationModel.findOne.mockResolvedValue({ id: 'recent' });

      await expect(service.sendVerificationCode({ email })).rejects.toThrow(
        HttpException,
      );
      await expect(
        service.sendVerificationCode({ email }),
      ).rejects.toMatchObject({ status: 429 });
      expect(emailVerificationModel.create).not.toHaveBeenCalled();
      expect(resend.emails.send).not.toHaveBeenCalled();
    });

    it('invalidates older codes and stores only an Argon2id hash of the new one', async () => {
      await service.sendVerificationCode({ email });

      expect(emailVerificationModel.updateMany).toHaveBeenCalledWith(
        { email, used: false },
        { used: true },
      );

      const stored = emailVerificationModel.create.mock.calls[0][0];
      expect(stored.email).toBe(email);
      expect(stored.code_hash.startsWith('$argon2id$')).toBe(true);
      expect(stored.expires_at.getTime()).toBeGreaterThan(Date.now());

      // The emailed code must be 6 digits and match the stored hash.
      const html: string = resend.emails.send.mock.calls[0][0].html;
      const code = html.match(/\d{6}/)?.[0];
      expect(code).toBeDefined();
      expect(await argon2.verify(stored.code_hash, code!)).toBe(true);
    });

    it('normalizes the email to lowercase before storing and sending', async () => {
      await service.sendVerificationCode({ email: 'Alex@UCF.EDU' });

      expect(emailVerificationModel.create.mock.calls[0][0].email).toBe(email);
      expect(resend.emails.send.mock.calls[0][0].to).toBe(email);
    });
  });

  describe('verifyCode', () => {
    const email = 'alex@ucf.edu';
    const code = '123456';

    const buildRecord = async (overrides = {}) => ({
      email,
      code_hash: await argon2.hash(code, { type: argon2.argon2id }),
      used: false,
      attempts: 0,
      save: jest.fn(),
      ...overrides,
    });

    it('rejects a malformed code with 400 before touching the DB', async () => {
      await expect(
        service.verifyCode({ email, code: 'abcdef' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emailVerificationModel.findOne).not.toHaveBeenCalled();
    });

    it('rejects with 400 when there is no active code for the email', async () => {
      emailVerificationModel.findOne.mockResolvedValue(null);
      await expect(service.verifyCode({ email, code })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(usersService.activatePendingByEmail).not.toHaveBeenCalled();
    });

    it('counts a wrong guess without activating the account', async () => {
      const record = await buildRecord();
      emailVerificationModel.findOne.mockResolvedValue(record);

      await expect(
        service.verifyCode({ email, code: '000000' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(record.attempts).toBe(1);
      expect(record.used).toBe(false);
      expect(record.save).toHaveBeenCalled();
      expect(usersService.activatePendingByEmail).not.toHaveBeenCalled();
    });

    it('invalidates the code after too many wrong guesses', async () => {
      const record = await buildRecord({ attempts: 4 });
      emailVerificationModel.findOne.mockResolvedValue(record);

      await expect(
        service.verifyCode({ email, code: '000000' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(record.used).toBe(true);
      expect(usersService.activatePendingByEmail).not.toHaveBeenCalled();
    });

    it('marks the code used and activates the pending account on success', async () => {
      const record = await buildRecord();
      emailVerificationModel.findOne.mockResolvedValue(record);

      const result = await service.verifyCode({ email, code });

      expect(record.used).toBe(true);
      expect(record.save).toHaveBeenCalled();
      expect(usersService.activatePendingByEmail).toHaveBeenCalledWith(email);
      expect(result).toEqual({ message: 'Email verified successfully.' });
    });
  });

  describe('forgotPassword', () => {
    const email = 'alex@ucf.edu';
    const GENERIC = 'If that email exists, a reset link has been sent.';

    const activeUser = {
      account_status: AccountStatus.Active,
      deleted_at: null,
    };

    /** The token embedded in the emailed link, recovered from the sent HTML. */
    const sentToken = (): string => {
      const { html } = resend.emails.send.mock.calls[0][0];
      return /reset-password\?token=([a-f0-9]+)/.exec(html)![1];
    };

    it('rejects a non-UCF email with 400 before touching the DB', async () => {
      await expect(
        service.forgotPassword({ email: 'alex@gmail.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(passwordResetModel.create).not.toHaveBeenCalled();
      expect(resend.emails.send).not.toHaveBeenCalled();
    });

    it('answers generically for an unknown email without sending', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword({ email });

      expect(result).toEqual({ message: GENERIC });
      expect(resend.emails.send).not.toHaveBeenCalled();
      expect(passwordResetModel.create).not.toHaveBeenCalled();
    });

    it('answers generically for a suspended account without sending', async () => {
      usersService.findByEmail.mockResolvedValue({
        account_status: AccountStatus.Suspended,
        deleted_at: null,
      });

      const result = await service.forgotPassword({ email });

      // Same message as a real send — a suspension must stay invisible here.
      expect(result).toEqual({ message: GENERIC });
      expect(resend.emails.send).not.toHaveBeenCalled();
    });

    it('answers generically for a soft-deleted account without sending', async () => {
      usersService.findByEmail.mockResolvedValue({
        account_status: AccountStatus.Active,
        deleted_at: new Date(),
      });

      const result = await service.forgotPassword({ email });

      expect(result).toEqual({ message: GENERIC });
      expect(resend.emails.send).not.toHaveBeenCalled();
    });

    it('stores only a SHA-256 hash of the token, never the token itself', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);

      await service.forgotPassword({ email });

      const token = sentToken();
      const stored = passwordResetModel.create.mock.calls[0][0];

      expect(stored.token_hash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      // The emailed secret must not be recoverable from the stored row.
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(stored).not.toHaveProperty('token');
    });

    it('issues a 32-byte token with a one-hour expiry', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);
      const before = Date.now();

      await service.forgotPassword({ email });

      expect(sentToken()).toHaveLength(64); // 32 bytes, hex-encoded
      const { expires_at } = passwordResetModel.create.mock.calls[0][0];
      const ttl = expires_at.getTime() - before;
      expect(ttl).toBeGreaterThan(59 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    it('invalidates older links before issuing a new one', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);

      await service.forgotPassword({ email });

      expect(passwordResetModel.updateMany).toHaveBeenCalledWith(
        { email, used: false },
        { used: true },
      );
    });

    it('stays silent during the per-email cooldown without sending', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);
      passwordResetModel.findOne.mockResolvedValue({ email }); // a recent link

      const result = await service.forgotPassword({ email });

      // Generic even here: a cooldown that only fired for real accounts would
      // leak existence as loudly as an explicit "no such user".
      expect(result).toEqual({ message: GENERIC });
      expect(resend.emails.send).not.toHaveBeenCalled();
      expect(passwordResetModel.create).not.toHaveBeenCalled();
    });

    it('normalizes the email to lowercase before storing and sending', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);

      await service.forgotPassword({ email: 'Alex@UCF.edu' });

      expect(passwordResetModel.create.mock.calls[0][0].email).toBe(email);
      expect(resend.emails.send.mock.calls[0][0].to).toBe(email);
    });

    it('surfaces a failed send as 502', async () => {
      usersService.findByEmail.mockResolvedValue(activeUser);
      resend.emails.send.mockResolvedValue({ error: { message: 'nope' } });

      await expect(service.forgotPassword({ email })).rejects.toBeInstanceOf(
        HttpException,
      );
    });
  });

  describe('resetPassword', () => {
    const email = 'alex@ucf.edu';
    const token = 'a'.repeat(64);
    const new_password = 'N3wPassw0rd!';
    const token_hash = createHash('sha256').update(token).digest('hex');

    const liveRecord = () => ({ _id: 'reset-1', email, used: false });

    it('rejects an unknown or expired token with 400', async () => {
      passwordResetModel.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token, new_password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.updatePasswordByEmail).not.toHaveBeenCalled();
    });

    it('looks the token up by hash, never by its raw value', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());

      await service.resetPassword({ token, new_password });

      expect(passwordResetModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ token_hash, used: false }),
      );
    });

    it('rejects a weak password with 400 without consuming the token', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());

      await expect(
        service.resetPassword({ token, new_password: 'weak' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(passwordResetModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(usersService.updatePasswordByEmail).not.toHaveBeenCalled();
    });

    it('rejects a breached password with 400 without consuming the token', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());
      pwnedPasswordService.isPwned.mockResolvedValue(true);

      await expect(
        service.resetPassword({ token, new_password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The user's one link must survive a rejected password.
      expect(passwordResetModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(usersService.updatePasswordByEmail).not.toHaveBeenCalled();
    });

    it('claims the token atomically, guarded on used: false', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());

      await service.resetPassword({ token, new_password });

      expect(passwordResetModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reset-1', used: false },
        { used: true },
      );
    });

    it('does not change the password when a concurrent request already claimed the token', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());
      // The atomic claim matches nothing: another request won the race.
      passwordResetModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token, new_password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.updatePasswordByEmail).not.toHaveBeenCalled();
    });

    it('stores an Argon2id hash of the new password, never the plaintext', async () => {
      passwordResetModel.findOne.mockResolvedValue(liveRecord());

      const result = await service.resetPassword({ token, new_password });

      const [toEmail, hash] = usersService.updatePasswordByEmail.mock.calls[0];
      expect(toEmail).toBe(email);
      expect(hash).not.toBe(new_password);
      expect(hash.startsWith('$argon2id$')).toBe(true);
      await expect(argon2.verify(hash, new_password)).resolves.toBe(true);
      expect(result).toEqual({ message: 'Password reset successfully.' });
    });
  });

  describe('changePassword', () => {
    const userId = 'user-id';
    const current_password = 'CurrentPassw0rd!';
    const new_password = 'N3wPassw0rd!';

    const buildUser = async (overrides = {}) => ({
      id: userId,
      password: await argon2.hash(current_password, { type: argon2.argon2id }),
      ...overrides,
    });

    it('rejects when there is no authenticated user with 401', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        service.changePassword(userId, { current_password, new_password }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(usersService.updatePasswordById).not.toHaveBeenCalled();
    });

    it('looks the user up with the password field selected', async () => {
      usersService.findById.mockResolvedValue(await buildUser());

      await service.changePassword(userId, { current_password, new_password });

      expect(usersService.findById).toHaveBeenCalledWith(userId, true);
    });

    it('rejects an incorrect current password with 400 without changing anything', async () => {
      usersService.findById.mockResolvedValue(await buildUser());

      await expect(
        service.changePassword(userId, {
          current_password: 'WrongPassw0rd!',
          new_password,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.updatePasswordById).not.toHaveBeenCalled();
    });

    it('rejects a weak new password with 400 without changing anything', async () => {
      usersService.findById.mockResolvedValue(await buildUser());

      await expect(
        service.changePassword(userId, { current_password, new_password: 'weak' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.updatePasswordById).not.toHaveBeenCalled();
    });

    it('rejects a breached new password with 400 without changing anything', async () => {
      usersService.findById.mockResolvedValue(await buildUser());
      pwnedPasswordService.isPwned.mockResolvedValue(true);

      await expect(
        service.changePassword(userId, { current_password, new_password }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.updatePasswordById).not.toHaveBeenCalled();
    });

    it('stores an Argon2id hash of the new password by id, never the plaintext', async () => {
      usersService.findById.mockResolvedValue(await buildUser());

      const result = await service.changePassword(userId, {
        current_password,
        new_password,
      });

      const [id, hash] = usersService.updatePasswordById.mock.calls[0];
      expect(id).toBe(userId);
      expect(hash).not.toBe(new_password);
      expect(hash.startsWith('$argon2id$')).toBe(true);
      await expect(argon2.verify(hash, new_password)).resolves.toBe(true);
      expect(result).toEqual({
        message: 'Password changed successfully. Please log in again.',
      });
    });
  });
});
