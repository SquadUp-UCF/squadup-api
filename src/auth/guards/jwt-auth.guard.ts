/**
 * Route guard that enforces a valid JWT (delegates to the 'jwt' strategy).
 * Apply with `@UseGuards(JwtAuthGuard)` on any protected controller/route.
 */
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
