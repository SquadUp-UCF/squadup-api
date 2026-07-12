/**
 * Passport JWT strategy.
 *
 * Extracts a Bearer token, verifies its signature against `JWT_SECRET`, then
 * loads the user named by the token's `sub` claim. Soft-deleted, suspended, or
 * pending (email not yet verified) accounts are rejected so a still-valid
 * token cannot be used before verification or after the account is disabled,
 * as are tokens issued before the user's last password reset.
 * The returned value is attached to `request.user`.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { AccountStatus, UserDocument } from '../../users/schemas/user.schema';

interface JwtPayload {
  sub: string;
  /** Issued-at, in seconds since the epoch. Set by `@nestjs/jwt` on sign. */
  iat: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<UserDocument> {
    // Excludes soft-deleted accounts.
    const user = await this.usersService.findActiveById(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    // Registration issues a token immediately, but it must not grant access
    // until the email is verified.
    if (user.account_status === AccountStatus.Pending) {
      throw new UnauthorizedException('Please verify your email.');
    }
    if (user.account_status === AccountStatus.Suspended) {
      throw new UnauthorizedException('Account suspended');
    }
    // A password reset retires every token minted before it, so a stolen JWT
    // dies with the reset instead of outliving it. `iat` is in seconds, and
    // it is floored on sign — a token issued in the same second as the reset
    // is treated as older, which errs towards logging the user out.
    if (
      user.password_changed_at &&
      payload.iat * 1000 < user.password_changed_at.getTime()
    ) {
      throw new UnauthorizedException(
        'Password was changed. Please log in again.',
      );
    }
    return user;
  }
}
