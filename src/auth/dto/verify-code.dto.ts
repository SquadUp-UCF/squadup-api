import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class VerifyCodeDto {
  @ApiProperty({ example: 'ta326121@ucf.edu' })
  @IsEmail()
  @Matches(/@ucf\.edu$/i, {
    message: 'Must use a valid @ucf.edu email address.',
  })
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'Code must be exactly 6 digits.' })
  code: string;
}