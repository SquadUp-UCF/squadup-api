/**
 * User profile endpoints. Everything here requires a valid JWT.
 *
 *   GET    /api/users/me    — the authenticated user's own profile
 *   PATCH  /api/users/me    — update editable profile fields
 *   DELETE /api/users/me    — soft-delete the account
 *   GET    /api/users/:id   — another player's public profile
 */
import {
  BadRequestException,
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
  Query
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  AVATAR_FIELD,
  avatarMulterOptions,
  avatarPublicPath,
  MulterExceptionFilter,
} from './avatar-upload';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from './schemas/user.schema';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: "Get the authenticated user's profile" })
  @ApiResponse({ status: 200, description: 'The current user profile.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token.' })
  getMe(@CurrentUser() user: UserDocument) {
    // `user` is resolved by JwtStrategy; password is never selected.
    return user;
  }

  @Patch('me')
  @ApiOperation({ summary: "Update the authenticated user's profile" })
  @ApiResponse({ status: 200, description: 'Updated profile.' })
  @ApiResponse({ status: 409, description: 'Username already in use.' })
  updateMe(
    @CurrentUser() user: UserDocument,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Put('me/avatar')
  @UseInterceptors(FileInterceptor(AVATAR_FIELD, avatarMulterOptions))
  @UseFilters(MulterExceptionFilter)
  @ApiOperation({ summary: "Upload or replace the authenticated user's picture" })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [AVATAR_FIELD],
      properties: {
        [AVATAR_FIELD]: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG, or WebP image, 5 MB max.',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Updated profile with picture path.' })
  @ApiResponse({ status: 400, description: 'Missing file or unsupported type.' })
  @ApiResponse({ status: 413, description: 'Image exceeds the 5 MB limit.' })
  uploadAvatar(
    @CurrentUser() user: UserDocument,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException(
        `No image file provided (multipart field "${AVATAR_FIELD}").`,
      );
    }
    return this.usersService.setProfilePicture(
      user.id,
      avatarPublicPath(file.filename),
    );
  }

  @Delete('me/avatar')
  @ApiOperation({ summary: "Remove the authenticated user's picture" })
  @ApiResponse({ status: 200, description: 'Picture removed.' })
  removeAvatar(@CurrentUser() user: UserDocument) {
    return this.usersService.removeProfilePicture(user.id);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete the authenticated account' })
  @ApiResponse({ status: 204, description: 'Account soft-deleted.' })
  async deleteMe(@CurrentUser() user: UserDocument): Promise<void> {
    await this.usersService.softDelete(user.id);
  }


  @Get('me/saved-games')
  @ApiOperation({ summary: 'List the games the user has saved' })
  @ApiResponse({ status: 200, description: 'The saved games (full documents).' })
  getSavedGames(@CurrentUser() user: UserDocument) {
    return this.usersService.getSavedGames(user.id);
  }

  @Post('me/saved-games/:gameId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save (bookmark) a game without joining it' })
  @ApiResponse({ status: 200, description: 'Updated profile with the game saved.' })
  @ApiResponse({ status: 400, description: 'Invalid game id.' })
  saveGame(
    @CurrentUser() user: UserDocument,
    @Param('gameId') gameId: string,
  ) {
    return this.usersService.saveGame(user.id, gameId);
  }

  @Delete('me/saved-games/:gameId')
  @ApiOperation({ summary: 'Remove a game from the saved list' })
  @ApiResponse({ status: 200, description: 'Updated profile with the game unsaved.' })
  @ApiResponse({ status: 400, description: 'Invalid game id.' })
  unsaveGame(
    @CurrentUser() user: UserDocument,
    @Param('gameId') gameId: string,
  ) {
    return this.usersService.unsaveGame(user.id, gameId);
  }

  @Get('username-available')
  async usernameAvailable(@Query('username') username: string) {
    return { available: !(await this.usersService.isUsernameTaken(username)) };
  }

  @Get(':id')
  @ApiOperation({ summary: "View another player's public profile" })
  @ApiResponse({ status: 200, description: 'Public profile fields only.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicProfile(id);
  }
}
