/**
 * Payload for `PATCH /games/:id/position` — set (or clear) the caller's own
 * position on a game they're on. Omit `position` or send an empty string to
 * clear it.
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SetPositionDto {
  @ApiPropertyOptional({
    example: 'Midfielder',
    description: 'Your (sport-specific, free-text) position. Empty/omitted clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  position?: string;
}
