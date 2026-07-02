/**
 * Authentication logic: registration, login, JWT issuance, and UCF email verification.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { Resend } from 'resend';
import { UsersService } from '../users/users.service';
import { AccountStatus, UserDocument } from '../users/schemas/user.schema';
import { validateDto } from '../common/validation/validate-dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { PwnedPasswordService } from './pwned-password.service';
import { EmailVerification, EmailVerificationDocument } from './schemas/email-verification.schema';

export interface AuthResponse {
  token: string;
  user: { id: string; name: string; username: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly pwnedPasswordService: PwnedPasswordService,
    private readonly configService: ConfigService,
    @InjectModel(EmailVerification.name)
    private readonly emailVerificationModel: Model<EmailVerificationDocument>,
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
    if (user.account_status === AccountStatus.Suspended) throw new ForbiddenException('Account suspended');
    return this.buildAuthResponse(user);
  }

  async sendVerificationCode(email: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail.endsWith('@ucf.edu')) {
      throw new BadRequestException('Must use a valid @ucf.edu email.');
    }
    await this.emailVerificationModel.updateMany(
      { email: normalizedEmail, used: false },
      { used: true },
    );
    const { randomInt } = await import('crypto');
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.emailVerificationModel.create({ email: normalizedEmail, code, expiresAt });
    await this.resend.emails.send({
      from: 'Squad Up <onboarding@resend.dev>',
      to: normalizedEmail,
      subject: 'Your Verification Code',
      html: '<p>Your verification code is: <strong>' + code + '</strong></p><p>Expires in 10 minutes.</p>',
    });
    return { message: 'Verification code sent.' };
  }

  async verifyCode(email: string, code: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const record = await this.emailVerificationModel.findOne({
      email: normalizedEmail,
      code,
      used: false,
      expiresAt: { $gt: new Date() },
    });
    if (!record) throw new BadRequestException('Invalid or expired code.');
    record.used = true;
    await record.save();
    await this.usersService.activateByEmail(normalizedEmail);
    return { message: 'Email verified successfully.' };
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