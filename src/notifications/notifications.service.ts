import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    private readonly configService: ConfigService,
  ) {
    if (!getApps().length) {
      const keyPath = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH') ?? '';
      console.log('Firebase key path:', keyPath);
      const serviceAccount = JSON.parse(fs.readFileSync(path.resolve(keyPath), 'utf8'));
      initializeApp({
        credential: cert(serviceAccount),
      });
    }
  }

  async send(params: {
    userId: string;
    deviceToken: string;
    type: NotificationType;
    title: string;
    body: string;
    gameId?: string;
  }): Promise<void> {
    await this.notificationModel.create({
      userId: new Types.ObjectId(params.userId),
      type: params.type,
      title: params.title,
      body: params.body,
      gameId: params.gameId ? new Types.ObjectId(params.gameId) : null,
    });

    try {
      await getMessaging().send({
        token: params.deviceToken,
        notification: {
          title: params.title,
          body: params.body,
        },
        data: {
          type: params.type,
          gameId: params.gameId ?? '',
        },
      });
    } catch (err) {
      this.logger.warn(`Push notification failed for user ${params.userId}: ${err.message}`);
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