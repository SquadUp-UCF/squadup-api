import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';
import { NotificationsService } from './notifications.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@ApiTags('notifications')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('device-token')
  @ApiOperation({ summary: 'Register a device token for push notifications' })
  @ApiResponse({ status: 201, description: 'Device token registered.' })
  registerDevice(
    @CurrentUser() user: UserDocument,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.notificationsService.registerDeviceToken(
      user.id,
      dto.token,
      dto.platform ?? 'ios',
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all notifications for the current user' })
  getMyNotifications(@CurrentUser() user: UserDocument) {
    return this.notificationsService.getForUser(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@Param('id') id: string, @CurrentUser() user: UserDocument) {
    return this.notificationsService.markRead(id, user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: UserDocument) {
    return this.notificationsService.markAllRead(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear (permanently delete) all notifications for the current user' })
  clearAll(@CurrentUser() user: UserDocument) {
    return this.notificationsService.clearAll(user.id);
  }
}