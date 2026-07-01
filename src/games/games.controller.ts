/**
 * Pickup game endpoints. Everything here requires a valid JWT; the acting user
 * is resolved from the token via `@CurrentUser()`, never from the request body.
 *
 *   POST   /api/games              — host a new game
 *   GET    /api/games              — discover games (sport/status/upcoming)
 *   GET    /api/games/:id          — a single game
 *   PATCH  /api/games/:id          — edit a game (host only)
 *   POST   /api/games/:id/join     — join a game's roster
 *   POST   /api/games/:id/leave    — leave a game's roster
 *   POST   /api/games/:id/cancel   — cancel a game (host only)
 *   POST   /api/games/:id/complete — mark a game completed (host only)
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GamesService } from './games.service';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { ListGamesDto } from './dto/list-games.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@ApiTags('games')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Post()
  @ApiOperation({ summary: 'Host a new game' })
  @ApiResponse({ status: 201, description: 'The created game.' })
  @ApiResponse({ status: 400, description: 'Invalid payload.' })
  create(@CurrentUser() user: UserDocument, @Body() dto: CreateGameDto) {
    return this.gamesService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Discover games' })
  @ApiResponse({ status: 200, description: 'Matching games.' })
  findMany(@Query() query: ListGamesDto) {
    return this.gamesService.findMany(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single game' })
  @ApiResponse({ status: 200, description: 'The game.' })
  @ApiResponse({ status: 404, description: 'Game not found.' })
  findOne(@Param('id') id: string) {
    return this.gamesService.findByIdOrFail(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a game (host only)' })
  @ApiResponse({ status: 200, description: 'The updated game.' })
  @ApiResponse({ status: 403, description: 'Only the host can edit.' })
  update(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
    @Body() dto: UpdateGameDto,
  ) {
    return this.gamesService.update(id, user.id, dto);
  }

  @Post(':id/join')
  @ApiOperation({ summary: 'Join a game' })
  @ApiResponse({ status: 200, description: 'The joined game.' })
  @ApiResponse({ status: 400, description: 'Game full/started or already joined.' })
  join(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.join(id, user.id);
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'Leave a game' })
  @ApiResponse({ status: 200, description: 'The updated game.' })
  @ApiResponse({ status: 400, description: 'Host cannot leave / not on roster.' })
  leave(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.leave(id, user.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a game (host only)' })
  @ApiResponse({ status: 200, description: 'The cancelled game.' })
  @ApiResponse({ status: 403, description: 'Only the host can cancel.' })
  cancel(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.cancel(id, user.id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a game completed (host only)' })
  @ApiResponse({ status: 200, description: 'The completed game.' })
  @ApiResponse({ status: 403, description: 'Only the host can complete.' })
  complete(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.complete(id, user.id);
  }
}
