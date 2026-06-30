/**
 * Payload for `POST /api/auth/register`.
 */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
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

  @ApiProperty({ example: 'alex@school.edu' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}
