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
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PwnedPasswordService } from './pwned-password.service';
import { AccountStatus } from '../users/schemas/user.schema';
import { EmailVerification } from './schemas/email-verification.schema';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    create: jest.Mock;
    findByEmail: jest.Mock;
    activatePendingByEmail: jest.Mock;
  };
  let jwtService: { sign: jest.Mock };
  let pwnedPasswordService: { isPwned: jest.Mock };
  let emailVerificationModel: {
    findOne: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  let resend: { emails: { send: jest.Mock } };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    usersService = {
      create: jest.fn(),
      findByEmail: jest.fn(),
      activatePendingByEmail: jest.fn(),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    // Default: password is not breached; individual tests override as needed.
    pwnedPasswordService = { isPwned: jest.fn().mockResolvedValue(false) };
    emailVerificationModel = {
      findOne: jest.fn().mockResolvedValue(null),
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
});
