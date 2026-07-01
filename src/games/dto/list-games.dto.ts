/**
 * Query filters for `GET /games`. All optional. `upcoming` defaults to true so
 * discovery shows future games; pass `upcoming=false` to include past ones.
 *
 * Values arrive as strings from the query string, so `upcoming` is coerced from
 * `'true'`/`'false'` before validation.
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { GameStatus } from '../schemas/game.schema';

export class ListGamesDto {
  @ApiPropertyOptional({ example: 'soccer' })
  @IsOptional()
  @IsString()
  sport?: string;

  @ApiPropertyOptional({ enum: GameStatus })
  @IsOptional()
  @IsEnum(GameStatus)
  status?: GameStatus;

  @ApiPropertyOptional({
    default: true,
    description: 'Only games whose start_time is in the future.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'false') return false;
    if (value === 'true') return true;
    return value;
  })
  @IsBoolean()
  upcoming?: boolean;
}
