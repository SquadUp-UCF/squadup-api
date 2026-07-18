/**
 * Payload for `POST /games/:id/ratings` — a player's thumbs up/down for the
 * other participants of a completed game. Only registered users can be rated.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, ValidateNested } from 'class-validator';

export class PlayerRatingDto {
  @ApiProperty({ description: 'Rated user id.' })
  @IsMongoId()
  user: string;

  @ApiProperty({ enum: ['up', 'down'] })
  @IsIn(['up', 'down'])
  value: 'up' | 'down';
}

export class RateGameDto {
  @ApiProperty({ type: [PlayerRatingDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlayerRatingDto)
  ratings: PlayerRatingDto[];
}
