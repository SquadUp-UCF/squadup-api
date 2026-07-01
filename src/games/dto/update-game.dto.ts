/**
 * Payload for `PATCH /games/:id` (host only). Every field is optional so the
 * host can edit any subset. `status` and `participants` are not editable here —
 * status changes flow through join/leave/cancel/complete.
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateGameDto {
  @ApiPropertyOptional({ example: 'soccer' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sport?: string;

  @ApiPropertyOptional({ example: 'Casual 5-a-side, all levels welcome.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'North Campus Field 2' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ example: '2026-07-15T18:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  start_time?: string;

  @ApiPropertyOptional({ example: 40.7128 })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: -74.006 })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  min_players?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_players?: number;

  @ApiPropertyOptional({ example: 'https://cdn.squadup.app/games/abc.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo_url?: string;
}
