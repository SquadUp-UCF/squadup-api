/**
 * Authentication logic: registration, login, JWT issuance, UCF email
 * verification, and password reset.
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
import { randomInt, randomBytes } from 'crypto';
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

export interface AuthResponse {
  token: string;
  user: { id: string; name: string; username: string };
}

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
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
    @InjectModel(PasswordReset.name)
    private readonly passwordResetModel: Model<PasswordResetDocument>,
    @Inject('RESEND') private readonly resend: Resend,
  ) {}

  async register(payload: RegisterDto): Promise<AuthResponse> {
    const dto = await validateDto(RegisterDto, payload);
    if (await this.pwnedPasswordService.isPwned(dto.password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach; please choose another.',
      );
    }
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = await this.usersService.create({
      first_name: dto.first_name,
      last_name: dto.last_name,
      username: dto.username,
      email: dto.email,
      password: passwordHash,
    });
    return this.buildAuthResponse(user);
  }

  async login(payload: LoginDto): Promise<AuthResponse> {
    const dto = await validateDto(LoginDto, payload);
    const user = await this.usersService.findByEmail(dto.email, true);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const passwordMatches = await argon2.verify(user.password, dto.password);
    if (!passwordMatches) throw new UnauthorizedException('Invalid credentials');
    if (user.deleted_at) throw new UnauthorizedException('Invalid credentials');
    if (user.account_status === AccountStatus.Pending) {
      throw new UnauthorizedException('Please verify your email before logging in.');
    }
    if (user.account_status === AccountStatus.Suspended) {
      throw new ForbiddenException('Account suspended');
    }
    return this.buildAuthResponse(user);
  }

  async sendVerificationCode(payload: SendCodeDto): Promise<{ message: string }> {
    const dto = await validateDto(SendCodeDto, payload);
    const email = dto.email.toLowerCase().trim();

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

    await this.emailVerificationModel.updateMany({ email, used: false }, { used: true });

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
      from: this.configService.get<string>('RESEND_FROM') || 'Squad Up <onboarding@resend.dev>',
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (error) {
      this.logger.error(`Failed to send verification code to ${email}: ${JSON.stringify(error)}`);
      throw new HttpException('Could not send verification code. Please try again.', HttpStatus.BAD_GATEWAY);
    }

    return { message: 'Verification code sent.' };
  }

  async verifyCode(payload: VerifyCodeDto): Promise<{ message: string }> {
    const dto = await validateDto(VerifyCodeDto, payload);
    const email = dto.email.toLowerCase().trim();

    const record = await this.emailVerificationModel.findOne({
      email,
      used: false,
      expires_at: { $gt: new Date() },
    });
    if (!record) throw new BadRequestException('Invalid or expired code.');

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

  async forgotPassword(payload: ForgotPasswordDto): Promise<{ message: string }> {
    const dto = await validateDto(ForgotPasswordDto, payload);
    const email = dto.email.toLowerCase().trim();

    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return { message: 'If that email exists, a reset link has been sent.' };
    }

    await this.passwordResetModel.updateMany({ email, used: false }, { used: true });

    const token = randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 60 * 60 * 1000);

    await this.passwordResetModel.create({ email, token, expires_at });

    const resetUrl = `${this.configService.get<string>('FRONTEND_URL') || 'https://squad-up-ucf.net'}/reset-password?token=${token}`;

    const { error } = await this.resend.emails.send({
      from: this.configService.get<string>('RESEND_FROM') || 'Squad Up <onboarding@resend.dev>',
      to: email,
      subject: 'Reset your Squad Up password',
      html: `<p>Click the link below to reset your password. It expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
      text: `Reset your password: ${resetUrl}`,
    });

    if (error) {
      this.logger.error(`Failed to send reset email to ${email}: ${JSON.stringify(error)}`);
      throw new HttpException('Could not send reset email. Please try again.', HttpStatus.BAD_GATEWAY);
    }

    return { message: 'If that email exists, a reset link has been sent.' };
  }

  async resetPassword(payload: ResetPasswordDto): Promise<{ message: string }> {
    const dto = await validateDto(ResetPasswordDto, payload);

    const record = await this.passwordResetModel.findOne({
      token: dto.token,
      used: false,
      expires_at: { $gt: new Date() },
    });

    if (!record) throw new BadRequestException('Invalid or expired reset token.');

    if (await this.pwnedPasswordService.isPwned(dto.new_password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach; please choose another.',
      );
    }

    const passwordHash = await argon2.hash(dto.new_password, { type: argon2.argon2id });
    await this.usersService.updatePasswordByEmail(record.email, passwordHash);

    record.used = true;
    await record.save();

    return { message: 'Password reset successfully.' };
  }

  private signToken(userId: string): string {
    return this.jwtService.sign({ sub: userId });
  }

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