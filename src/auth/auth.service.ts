/**
 * Authentication logic: registration, login, JWT issuance, and UCF email
 * verification.
 *
 * Passwords are hashed with Argon2id (a memory-hard, modern KDF) and access is
 * granted via signed JWTs. The service also enforces that suspended, pending
 * (email not yet verified), or soft-deleted accounts cannot log in.
 *
 * Email verification flow: accounts start as `pending`. `send-code` emails a
 * 6-digit one-time code (10-minute TTL, stored only as an Argon2id hash);
 * `verify-code` checks it and promotes the account to `active`.
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { Resend } from 'resend';
import { UsersService } from '../users/users.service';
import { AccountStatus, UserDocument } from '../users/schemas/user.schema';
import { validateDto } from '../common/validation/validate-dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { PwnedPasswordService } from './pwned-password.service';
import {
  EmailVerification,
  EmailVerificationDocument,
} from './schemas/email-verification.schema';
import { buildVerificationEmail } from './templates/verification-email';

export interface AuthResponse {
  token: string;
  user: { id: string; name: string; username: string };
}

/** How long a verification code stays valid. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Minimum wait between two codes for the same email (anti-spam). */
const RESEND_COOLDOWN_MS = 60 * 1000;
/** Failed guesses before a code is invalidated (anti-brute-force). */
const MAX_VERIFY_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly pwnedPasswordService: PwnedPasswordService,
    private readonly configService: ConfigService,
    @InjectModel(EmailVerification.name)
    private readonly emailVerificationModel: Model<EmailVerificationDocument>,
    @Inject('RESEND') private readonly resend: Resend,
  ) {}

  /** Register a new user: hash the password with Argon2id, then persist. */
  async register(payload: RegisterDto): Promise<AuthResponse> {
    const dto = await validateDto(RegisterDto, payload);

    // Reject passwords known to have appeared in a public breach.
    if (await this.pwnedPasswordService.isPwned(dto.password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach; please choose another.',
      );
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    const user = await this.usersService.create({
      first_name: dto.first_name,
      last_name: dto.last_name,
      username: dto.username,
      email: dto.email,
      password: passwordHash,
    });

    return this.buildAuthResponse(user);
  }

  /** Authenticate by email + password and issue a token. */
  async login(payload: LoginDto): Promise<AuthResponse> {
    const dto = await validateDto(LoginDto, payload);

    // Must explicitly request the password — it is `select: false` by default.
    const user = await this.usersService.findByEmail(dto.email, true);

    // Generic message so we don't reveal whether the email exists.
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await argon2.verify(user.password, dto.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Valid credentials, but the account may not be allowed to sign in.
    if (user.deleted_at) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.account_status === AccountStatus.Pending) {
      throw new UnauthorizedException(
        'Please verify your email before logging in.',
      );
    }
    if (user.account_status === AccountStatus.Suspended) {
      throw new ForbiddenException('Account suspended');
    }

    return this.buildAuthResponse(user);
  }

  /**
   * Email a fresh verification code. Enforces a per-email cooldown, invalidates
   * any previous codes, and stores only the Argon2id hash of the new one.
   */
  async sendVerificationCode(
    payload: SendCodeDto,
  ): Promise<{ message: string }> {
    const dto = await validateDto(SendCodeDto, payload);
    const email = dto.email.toLowerCase().trim();

    // Per-email cooldown, tracked in the DB so it holds across instances.
    const recent = await this.emailVerificationModel.findOne({
      email,
      createdAt: { $gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
    });
    if (recent) {
      throw new HttpException(
        'Please wait before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Only the newest code may be redeemed.
    await this.emailVerificationModel.updateMany(
      { email, used: false },
      { used: true },
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.emailVerificationModel.create({
      email,
      code_hash: await argon2.hash(code, { type: argon2.argon2id }),
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    });

    const emailContent = buildVerificationEmail({
      code,
      expiresMinutes: CODE_TTL_MS / 60_000,
      logoUrl:
        this.configService.get<string>('EMAIL_LOGO_URL') ||
        'https://squad-up-ucf.net/logo.png',
    });
    const { error } = await this.resend.emails.send({
      from:
        this.configService.get<string>('RESEND_FROM') ||
        'Squad Up <onboarding@resend.dev>',
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });
    if (error) {
      // Resend reports failures in the returned `error` (it does not throw), so
      // log the reason — otherwise a rejected send looks like success and the
      // code never arrives. Common cause: sending from the `onboarding@resend.dev`
      // sandbox sender, which only delivers to the Resend account owner.
      this.logger.error(
        `Failed to send verification code to ${email}: ${JSON.stringify(error)}`,
      );
      throw new HttpException(
        'Could not send verification code. Please try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return { message: 'Verification code sent.' };
  }

  /**
   * Redeem a verification code: on success a pending account becomes active
   * (already-active or suspended accounts are left untouched). Wrong guesses
   * are counted and the code is invalidated after `MAX_VERIFY_ATTEMPTS`, so a
   * 6-digit code cannot be brute-forced.
   */
  async verifyCode(payload: VerifyCodeDto): Promise<{ message: string }> {
    const dto = await validateDto(VerifyCodeDto, payload);
    const email = dto.email.toLowerCase().trim();

    const record = await this.emailVerificationModel.findOne({
      email,
      used: false,
      expires_at: { $gt: new Date() },
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired code.');
    }

    const matches = await argon2.verify(record.code_hash, dto.code);
    if (!matches) {
      record.attempts += 1;
      if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
        record.used = true;
      }
      await record.save();
      throw new BadRequestException('Invalid or expired code.');
    }

    record.used = true;
    await record.save();
    await this.usersService.activatePendingByEmail(email);

    return { message: 'Email verified successfully.' };
  }

  /** Sign a JWT whose subject is the user id. */
  private signToken(userId: string): string {
    return this.jwtService.sign({ sub: userId });
  }

  /** Shape the response returned by both register and login. */
  private buildAuthResponse(user: UserDocument): AuthResponse {
    return {
      token: this.signToken(user.id),
      user: {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        username: user.username,
      },
    };
  }
}
