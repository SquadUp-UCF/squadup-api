/**
 * Payload for `PATCH /api/auth/change-password`.
 *
 * The password rules mirror `RegisterDto`/`ResetPasswordDto` exactly. Unlike a
 * reset (which proves identity via an emailed token), this is authenticated by
 * the caller's JWT, so it additionally requires the current password.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentPassw0rd!' })
  @IsString()
  current_password: string;

  @ApiProperty({
    example: 'N3wPassw0rd!',
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
