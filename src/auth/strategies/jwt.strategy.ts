/**
 * Passport JWT strategy.
 *
 * Extracts a Bearer token, verifies its signature against `JWT_SECRET`, then
 * loads the user named by the token's `sub` claim. Soft-deleted or suspended
 * accounts are rejected so a still-valid token cannot be used after the account
 * is disabled. The returned value is attached to `request.user`.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { AccountStatus, UserDocument } from '../../users/schemas/user.schema';

interface JwtPayload {
  sub: string;
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
    if (user.account_status === AccountStatus.Suspended) {
      throw new UnauthorizedException('Account suspended');
    }
    return user;
  }
}
