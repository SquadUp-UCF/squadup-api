/**
 * Explicit, in-service payload validation.
 *
 * This project deliberately does NOT use a global `ValidationPipe`; services
 * validate their own inputs. This helper keeps the `class-validator` decorators
 * on the DTOs as the single source of truth, running them on demand: it coerces
 * the raw payload into a DTO instance, validates it, and throws a
 * `BadRequestException` (400) with the collected messages on failure.
 */
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

export async function validateDto<T extends object>(
  cls: new () => T,
  payload: unknown,
): Promise<T> {
  const instance = plainToInstance(cls, payload ?? {});
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    const messages = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );
    throw new BadRequestException(messages);
  }

  return instance;
}
