import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, Matches } from 'class-validator';

export class SendCodeDto {
  @ApiProperty({ example: 'ta326121@ucf.edu' })
  @IsEmail()
  @Matches(/@ucf\.edu$/i, {
    message: 'Must use a valid @ucf.edu email address.',
  })
  email: string;
}