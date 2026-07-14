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
 *
 * Password reset flow: `forgot-password` emails a single-use link carrying a
 * 32-byte random token (1-hour TTL, stored only as a SHA-256 hash);
 * `reset-password` redeems it, re-hashes the new password, and stamps
 * `password_changed_at` so JWTs minted before the reset stop being accepted.
 * Both steps answer with the same generic message whether or not the account
 * exists, so neither can be used to enumerate registered emails.
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
import { createHash, randomBytes, randomInt } from 'crypto';
import { Resend } from 'resend';
import { UsersService } from '../users/users.service';
import { AccountStatus, UserDocument } from '../users/schemas/user.schema';
import { validateDto } from '../common/validation/validate-dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { PwnedPasswordService } from './pwned-password.service';
import {
  EmailVerification,
  EmailVerificationDocument,
} from './schemas/email-verification.schema';
import {
  PasswordReset,
  PasswordResetDocument,
} from './schemas/password-reset.schema';
import { buildVerificationEmail } from './templates/verification-email';
import { buildPasswordResetEmail } from './templates/password-reset-email';

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
/** How long a password-reset link stays valid. */
const RESET_TTL_MS = 60 * 60 * 1000;
/** Minimum wait between two reset links for the same email (anti-spam). */
const RESET_COOLDOWN_MS = 60 * 1000;

/**
 * Answer given to `forgot-password` whatever the outcome — unknown email,
 * suspended account, or link actually sent. Anything more specific would turn
 * the endpoint into an account-existence oracle.
 */
const RESET_REQUESTED_MESSAGE =
  'If that email exists, a reset link has been sent.';

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
    @InjectModel(PasswordReset.name)
    private readonly passwordResetModel: Model<PasswordResetDocument>,
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

  /**
   * Email a single-use password-reset link.
   *
   * Always answers `RESET_REQUESTED_MESSAGE`, so an unknown email, a suspended
   * account and a genuine send are indistinguishable to the caller. Soft-deleted
   * and suspended accounts are silently skipped rather than mailed: sending them
   * a working link would only lead to a reset that `updatePasswordByEmail`
   * refuses to apply.
   */
  async forgotPassword(
    payload: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    const dto = await validateDto(ForgotPasswordDto, payload);
    const email = dto.email.toLowerCase().trim();

    const user = await this.usersService.findByEmail(email);
    if (!user || user.deleted_at) {
      return { message: RESET_REQUESTED_MESSAGE };
    }
    // A suspension must not be escapable by resetting the password.
    if (user.account_status === AccountStatus.Suspended) {
      return { message: RESET_REQUESTED_MESSAGE };
    }

    // Per-email cooldown, tracked in the DB so it holds across instances.
    // Without it the only limit is the controller's per-IP throttle, which an
    // attacker can sidestep to flood a victim's inbox with reset mail.
    const recent = await this.passwordResetModel.findOne({
      email,
      createdAt: { $gt: new Date(Date.now() - RESET_COOLDOWN_MS) },
    });
    if (recent) {
      // Still generic: a cooldown that only fires for real accounts would leak
      // existence just as loudly as an explicit "no such user".
      return { message: RESET_REQUESTED_MESSAGE };
    }

    // Only the newest link may be redeemed.
    await this.passwordResetModel.updateMany(
      { email, used: false },
      { used: true },
    );

    const token = randomBytes(32).toString('hex');
    await this.passwordResetModel.create({
      email,
      token_hash: this.hashResetToken(token),
      expires_at: new Date(Date.now() + RESET_TTL_MS),
    });

    const frontendUrl = (
      this.configService.get<string>('FRONTEND_URL') ||
      'https://squad-up-ucf.net'
    ).replace(/\/+$/, '');
    const emailContent = buildPasswordResetEmail({
      resetUrl: `${frontendUrl}/reset-password?token=${token}`,
      expiresMinutes: RESET_TTL_MS / 60_000,
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
      // link never arrives.
      this.logger.error(
        `Failed to send password-reset email to ${email}: ${JSON.stringify(error)}`,
      );
      throw new HttpException(
        'Could not send reset email. Please try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return { message: RESET_REQUESTED_MESSAGE };
  }

  /**
   * Redeem a reset link and set a new password.
   *
   * The token is claimed with a single atomic `findOneAndUpdate` guarded on
   * `used: false`, so two requests racing with the same link cannot both win.
   * The claim happens only after the new password has been validated and
   * hashed, so a rejected password (breached, malformed) does not burn the
   * user's one link.
   */
  async resetPassword(payload: ResetPasswordDto): Promise<{ message: string }> {
    const dto = await validateDto(ResetPasswordDto, payload);
    const token_hash = this.hashResetToken(dto.token);

    const record = await this.passwordResetModel.findOne({
      token_hash,
      used: false,
      expires_at: { $gt: new Date() },
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    // Reject passwords known to have appeared in a public breach.
    if (await this.pwnedPasswordService.isPwned(dto.new_password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach; please choose another.',
      );
    }

    const passwordHash = await argon2.hash(dto.new_password, {
      type: argon2.argon2id,
    });

    // Claim the token. Losing this race means another request already redeemed
    // it, so this one must not go on to change the password.
    const claimed = await this.passwordResetModel.findOneAndUpdate(
      { _id: record._id, used: false },
      { used: true },
    );
    if (!claimed) {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    // Stamps `password_changed_at`, which retires every JWT issued earlier —
    // the point of a reset when the account is already compromised.
    await this.usersService.updatePasswordByEmail(record.email, passwordHash);

    return { message: 'Password reset successfully.' };
  }

  /**
   * Change the authenticated user's password. Unlike `resetPassword`, identity
   * is already proven by the caller's JWT, so this proves intent instead by
   * requiring the current password.
   *
   * Stamps `password_changed_at` on success, which retires every JWT issued
   * before now — including the one that authenticated this very request — so
   * the caller must log in again afterward. That is the same trade-off
   * `resetPassword` makes, deliberately: a password change should not leave
   * old sessions (e.g. on a stolen device) still valid.
   */
  async changePassword(
    userId: string,
    payload: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const dto = await validateDto(ChangePasswordDto, payload);

    // Must explicitly request the password — it is `select: false` by default.
    const user = await this.usersService.findById(userId, true);
    if (!user) {
      throw new UnauthorizedException();
    }

    const currentMatches = await argon2.verify(
      user.password,
      dto.current_password,
    );
    if (!currentMatches) {
      throw new BadRequestException('Current password is incorrect');
    }

    // Reject passwords known to have appeared in a public breach.
    if (await this.pwnedPasswordService.isPwned(dto.new_password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach; please choose another.',
      );
    }

    const passwordHash = await argon2.hash(dto.new_password, {
      type: argon2.argon2id,
    });
    await this.usersService.updatePasswordById(userId, passwordHash);

    return { message: 'Password changed successfully. Please log in again.' };
  }

  /**
   * Hash a reset token for storage/lookup.
   *
   * SHA-256, not Argon2: the token is 32 bytes of CSPRNG output, so there is no
   * guessing attack to slow down, and an unsalted digest is what lets the token
   * be found by hash. See `password-reset.schema.ts`.
   */
  private hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
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
