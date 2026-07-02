import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';
import { DeviceToken, DeviceTokenDocument } from './schemas/device-token.schema';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(DeviceToken.name)
    private readonly deviceTokenModel: Model<DeviceTokenDocument>,
    private readonly configService: ConfigService,
  ) {
    if (!getApps().length) {
      const base64 = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_BASE64') ?? '';
      const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
      initializeApp({
        credential: cert(serviceAccount),
      });
    }
  }

  async registerDeviceToken(userId: string, token: string, platform: string): Promise<void> {
    await this.deviceTokenModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), token },
      { userId: new Types.ObjectId(userId), token, platform },
      { upsert: true, new: true },
    ).exec();
  }

  async getDeviceTokens(userId: string): Promise<string[]> {
    const tokens = await this.deviceTokenModel
      .find({ userId: new Types.ObjectId(userId) })
      .exec();
    return tokens.map(t => t.token);
  }

  async sendToUser(params: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    gameId?: string;
  }): Promise<void> {
    const tokens = await this.getDeviceTokens(params.userId);

    await this.notificationModel.create({
      userId: new Types.ObjectId(params.userId),
      type: params.type,
      title: params.title,
      body: params.body,
      gameId: params.gameId ? new Types.ObjectId(params.gameId) : null,
    });

    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: params.title, body: params.body },
          data: { type: params.type, gameId: params.gameId ?? '' },
        });
      } catch (err) {
        this.logger.warn(`Push failed for token ${token}: ${err.message}`);
      }
    }
  }

  async getForUser(userId: string): Promise<NotificationDocument[]> {
    return this.notificationModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
  }

  async markRead(notificationId: string, userId: string): Promise<void> {
    await this.notificationModel.updateOne(
      { _id: notificationId, userId: new Types.ObjectId(userId) },
      { read: true },
    ).exec();
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notificationModel.updateMany(
      { userId: new Types.ObjectId(userId), read: false },
      { read: true },
    ).exec();
  }
}