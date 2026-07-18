/**
 * Payload for `PATCH /api/users/me`. Every field is optional so callers can
 * update any subset of their editable profile.
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Alex' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  first_name?: string;

  @ApiPropertyOptional({ example: 'Rivera' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  last_name?: string;

  @ApiPropertyOptional({ example: 'alex_r', description: 'Unique public handle' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username?: string;

  @ApiPropertyOptional({
    description: 'Self-reported skill level per sport, keyed by sport.',
    example: { soccer: 'Intermediate', basketball: 'Beginner' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  skill_levels?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Preferred playing position per sport, keyed by sport.',
    example: { soccer: 'Goalkeeper', basketball: 'Point Guard' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  sport_positions?: Record<string, string>;
}
