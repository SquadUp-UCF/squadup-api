/**
 * Payload for `POST /games/:id/join`. Optional — omitting `party_size`
 * behaves exactly as before (a party of one, just the caller).
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class JoinGameDto {
  @ApiPropertyOptional({
    example: 3,
    minimum: 1,
    maximum: 20,
    description:
      'Total headcount this join represents, including the caller. Rejected if the group would exceed the remaining spots.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  party_size?: number;
}
