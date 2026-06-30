/**
 * Authentication logic: registration, login, and JWT issuance.
 *
 * Passwords are hashed with Argon2id (a memory-hard, modern KDF) and access is
 * granted via signed JWTs. The service also enforces that suspended or
 * soft-deleted accounts cannot log in.
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { UsersService } from '../users/users.service';
import { AccountStatus, UserDocument } from '../users/schemas/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface AuthResponse {
  token: string;
  user: { id: string; name: string; username: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /** Register a new user: hash the password with Argon2id, then persist. */
  async register(dto: RegisterDto): Promise<AuthResponse> {
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
  async login(dto: LoginDto): Promise<AuthResponse> {
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
    if (user.account_status === AccountStatus.Suspended) {
      throw new ForbiddenException('Account suspended');
    }

    return this.buildAuthResponse(user);
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
