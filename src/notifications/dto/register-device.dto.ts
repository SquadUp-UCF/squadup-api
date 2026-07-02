import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'fcm-device-token-here' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'ios', required: false })
  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: string;
}