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
 *   POST   /api/games/:id/ratings  — rate the other players of a completed game
 *   GET    /api/games/pending-ratings — completed games the caller hasn't rated yet
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { CreateGameDto, InitialPlayerDto } from './dto/create-game.dto';
import { RateGameDto } from './dto/rate-game.dto';
import { SetPositionDto } from './dto/set-position.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { JoinGameDto } from './dto/join-game.dto';
import { ListGamesDto } from './dto/list-games.dto';
import { MyGamesDto } from './dto/my-games.dto';
import { RateGameDto } from './dto/rate-game.dto';
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

  // Declared before `:id` so "mine" isn't captured as a game id.
  @Get('mine')
  @ApiOperation({ summary: "Games the caller hosts or plays in" })
  @ApiResponse({ status: 200, description: "The caller's games." })
  findMine(@CurrentUser() user: UserDocument, @Query() query: MyGamesDto) {
    return this.gamesService.findForUser(user.id, query);
  }

  // Declared before `:id` so "pending-ratings" isn't captured as a game id.
  @Get('pending-ratings')
  @ApiOperation({ summary: "Completed games the caller still needs to rate" })
  @ApiResponse({ status: 200, description: 'Games awaiting the caller\'s ratings.' })
  findPendingRatings(@CurrentUser() user: UserDocument) {
    return this.gamesService.findPendingRatings(user.id);
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a game (host only)' })
  @ApiResponse({ status: 204, description: 'The game was deleted.' })
  @ApiResponse({ status: 403, description: 'Only the host can delete.' })
  remove(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.remove(id, user.id);
  }

  @Post(':id/join')
  @ApiOperation({ summary: "Join a game, optionally for a party of more than one" })
  @ApiResponse({ status: 200, description: 'The joined game.' })
  @ApiResponse({ status: 400, description: "Game full/started, already joined, or the party doesn't fit the remaining spots." })
  join(@CurrentUser() user: UserDocument, @Param('id') id: string, @Body() dto: JoinGameDto) {
    return this.gamesService.join(id, user.id, dto);
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'Leave a game' })
  @ApiResponse({ status: 200, description: 'The updated game.' })
  @ApiResponse({ status: 400, description: 'Host cannot leave / not on roster.' })
  leave(@CurrentUser() user: UserDocument, @Param('id') id: string) {
    return this.gamesService.leave(id, user.id);
  }

  @Post(':id/guests')
  @ApiOperation({ summary: 'Add a guest player to the roster (host only)' })
  @ApiResponse({ status: 201, description: 'The updated game.' })
  @ApiResponse({ status: 400, description: 'Game full/started/terminal, or invalid guest.' })
  @ApiResponse({ status: 403, description: 'Only the host can add guests.' })
  addGuest(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
    @Body() dto: InitialPlayerDto,
  ) {
    return this.gamesService.addGuest(id, user.id, dto);
  }

  @Delete(':id/guests/:index')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Remove a guest from the roster by index (the host, or whoever added them)',
  })
  @ApiResponse({ status: 200, description: 'The updated game.' })
  @ApiResponse({ status: 400, description: 'No guest at that index.' })
  @ApiResponse({
    status: 403,
    description: 'Not the host, and not the player who added this guest.',
  })
  removeGuest(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.gamesService.removeGuest(id, user.id, index);
  }

  @Patch(':id/position')
  @ApiOperation({ summary: "Set your own position on a game you're on" })
  @ApiResponse({ status: 200, description: 'The updated game.' })
  @ApiResponse({ status: 400, description: 'Not on the roster, or the game is terminal.' })
  setMyPosition(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
    @Body() dto: SetPositionDto,
  ) {
    return this.gamesService.setMyPosition(id, user.id, dto);
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

  @Post(':id/ratings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rate the other players of a completed game (thumbs up/down)" })
  @ApiResponse({ status: 200, description: 'The game, now recorded as rated by the caller.' })
  @ApiResponse({ status: 400, description: 'Game not completed, or already rated.' })
  @ApiResponse({ status: 403, description: 'Only players in the game can rate it.' })
  rate(@CurrentUser() user: UserDocument, @Param('id') id: string, @Body() dto: RateGameDto) {
    return this.gamesService.rateGame(id, user.id, dto);
  }
}
