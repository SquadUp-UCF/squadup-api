/**
<<<<<<< HEAD
 * Payload for `POST /games/:id/ratings` — thumbs up/down for the other
 * (joined) players of a completed game. Ratees the caller isn't allowed to
 * rate (guests, non-participants, themselves) are silently dropped by the
 * service rather than rejected here.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  ValidateNested,
} from 'class-validator';

export class PlayerRatingDto {
  @ApiProperty({ example: '64f1c2b8e1a2b3c4d5e6f7a8' })
  @IsMongoId()
  user: string;

  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
=======
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
>>>>>>> 9dc8722731ef18d5fcb84271b24c3d72aff44029
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
