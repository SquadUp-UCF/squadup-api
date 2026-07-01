/**
 * Payload for `POST /games`. The host is taken from the JWT, never the body.
 * `min_players` must not exceed `max_players`.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateGameDto {
  @ApiProperty({ example: 'soccer' })
  @IsString()
  @MaxLength(50)
  sport: string;

  @ApiPropertyOptional({ example: 'Casual 5-a-side, all levels welcome.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 'North Campus Field 2' })
  @IsString()
  @MaxLength(200)
  location: string;

  @ApiProperty({
    example: '2026-07-15T18:00:00.000Z',
    description: 'Kickoff time (ISO 8601). Must be in the future.',
  })
  @IsDateString()
  start_time: string;

  @ApiProperty({ example: 40.7128 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: -74.006 })
  @IsLongitude()
  longitude: number;

  @ApiProperty({ example: 6, description: 'Roster size that confirms the game.' })
  @IsInt()
  @Min(1)
  min_players: number;

  @ApiProperty({ example: 10, description: 'Roster size that locks the game.' })
  @IsInt()
  @Min(1)
  max_players: number;

  @ApiPropertyOptional({ example: 'https://cdn.squadup.app/games/abc.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo_url?: string;
}
