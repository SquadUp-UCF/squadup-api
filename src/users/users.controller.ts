/**
 * User profile endpoints. Everything here requires a valid JWT.
 *
 *   GET    /api/users/me    — the authenticated user's own profile
 *   PATCH  /api/users/me    — update editable profile fields
 *   DELETE /api/users/me    — soft-delete the account
 *   GET    /api/users/:id   — another player's public profile
 */
import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
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

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete the authenticated account' })
  @ApiResponse({ status: 204, description: 'Account soft-deleted.' })
  async deleteMe(@CurrentUser() user: UserDocument): Promise<void> {
    await this.usersService.softDelete(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: "View another player's public profile" })
  @ApiResponse({ status: 200, description: 'Public profile fields only.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicProfile(id);
  }
}
