/**
 * Payload for `POST /api/auth/reset-password`.
 *
 * The password rules mirror `RegisterDto` exactly — a reset must not be a way
 * to slip a weaker password past the policy the account was created under.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: '3f1a…',
    description:
      'The token from the reset link. Single-use; expires in 1 hour.',
  })
  @IsString()
  token: string;

  @ApiProperty({
    example: 'Passw0rd!',
    minLength: 8,
    maxLength: 20,
    description:
      'Password: 8–20 characters, with at least one uppercase letter, one lowercase letter, one number, and one symbol.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  @Matches(/[A-Z]/, {
    message: 'password must contain at least one uppercase letter',
  })
  @Matches(/[a-z]/, {
    message: 'password must contain at least one lowercase letter',
  })
  @Matches(/[0-9]/, {
    message: 'password must contain at least one number',
  })
  @Matches(/[^A-Za-z0-9]/, {
    message: 'password must contain at least one symbol',
  })
  new_password: string;
}
