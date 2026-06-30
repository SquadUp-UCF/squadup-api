/**
 * `@CurrentUser()` param decorator.
 *
 * Returns the user object that JwtStrategy attached to the request after a
 * successful token validation, so controllers don't have to reach into the
 * raw request.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
