import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: DeviceToken.name, schema: DeviceTokenSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}