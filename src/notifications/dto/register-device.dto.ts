import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'fcm-device-token-here' })
  @IsString()
  @IsNotEmpty()
  token: string;
}