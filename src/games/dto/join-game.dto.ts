/**
 * Payload for `POST /games/:id/join`. Optional — omitting everything behaves as
 * a party of one (just the caller). `party_size` is an anonymous headcount;
 * `guests` lets the caller bring named players (each with an optional position),
 * which show up individually on the roster.
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { InitialPlayerDto } from './create-game.dto';

export class JoinGameDto {
  @ApiPropertyOptional({
    example: 3,
    minimum: 1,
    maximum: 20,
    description:
      'Total headcount this join represents, including the caller. Ignored when `guests` is provided.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  party_size?: number;

  @ApiPropertyOptional({
    type: [InitialPlayerDto],
    example: [{ name: 'Sam Lee', position: 'Setter' }],
    description:
      'Named guests the caller is bringing. Each counts toward the roster like a ' +
      'player and may carry an optional position. The caller is added automatically.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => InitialPlayerDto)
  guests?: InitialPlayerDto[];
}
