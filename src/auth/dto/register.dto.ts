/**
 * Payload for `POST /api/auth/register`.
 */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Alex' })
  @IsString()
  @MaxLength(50)
  first_name: string;

  @ApiProperty({ example: 'Rivera' })
  @IsString()
  @MaxLength(50)
  last_name: string;

  @ApiProperty({ example: 'alex_r', description: 'Unique public handle' })
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username: string;

  @ApiProperty({
    example: 'alex@ucf.edu',
    description: 'Must be a UCF email address (@ucf.edu).',
  })
  @IsEmail()
  @Matches(/@ucf\.edu$/i, {
    message: 'Registration is restricted to UCF email addresses (@ucf.edu)',
  })
  email: string;

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
  password: string;
}
