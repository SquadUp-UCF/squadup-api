/**
 * Payload for `POST /api/auth/forgot-password`.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, Matches } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'alex@ucf.edu',
    description: 'Must be a UCF email address (@ucf.edu).',
  })
  @IsEmail()
  @Matches(/@ucf\.edu$/i, {
    message: 'Registration is restricted to UCF email addresses (@ucf.edu)',
  })
  email: string;
}
