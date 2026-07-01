/**
 * Query filters for `GET /games/mine`. Both optional.
 *
 * `role` narrows to games you host vs. games you actively play in (default:
 * both). `status` narrows by lifecycle state (default: all, so the endpoint
 * doubles as history).
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { GameStatus } from '../schemas/game.schema';

/** Which side of a game the caller is on. */
export enum MyGamesRole {
  Hosting = 'hosting',
  Playing = 'playing',
}

export class MyGamesDto {
  @ApiPropertyOptional({
    enum: MyGamesRole,
    description: 'Only games you host or only games you play in. Default: both.',
  })
  @IsOptional()
  @IsEnum(MyGamesRole)
  role?: MyGamesRole;

  @ApiPropertyOptional({ enum: GameStatus })
  @IsOptional()
  @IsEnum(GameStatus)
  status?: GameStatus;
}
