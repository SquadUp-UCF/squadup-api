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
  // Whether Firebase Cloud Messaging is configured. When it isn't (e.g. local
  // dev without a service-account credential) we still persist notifications to
  // Mongo but skip the push send instead of crashing the app at boot.
  private readonly pushEnabled: boolean;

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(DeviceToken.name)
    private readonly deviceTokenModel: Model<DeviceTokenDocument>,
    private readonly configService: ConfigService,
  ) {
    const base64 = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_BASE64') ?? '';

    if (!base64) {
      this.pushEnabled = false;
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 not set — push notifications disabled.',
      );
      return;
    }

    try {
      if (!getApps().length) {
        const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
        initializeApp({ credential: cert(serviceAccount) });
      }
      this.pushEnabled = true;
    } catch (err) {
      this.pushEnabled = false;
      this.logger.warn(
        `Firebase init failed — push notifications disabled: ${(err as Error).message}`,
      );
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

    const userId = new Types.ObjectId(params.userId);
    const gameId = params.gameId ? new Types.ObjectId(params.gameId) : null;
    const now = new Date();

    // Repeat events of the same kind about the same game collapse into the
    // single unread row rather than stacking up — three people joining reads as
    // one "someone joined" the host hasn't looked at yet, not three identical
    // lines. Once the row has been read, the next event starts a fresh one.
    //
    // Everything is written through `$set` (with the timestamps plugin off) so
    // an upsert can own `createdAt`: leaving it to `$setOnInsert` would collide
    // with the `$set` and Mongo would reject the whole update.
    const collapsible = gameId !== null;
    if (collapsible) {
      await this.notificationModel
        .findOneAndUpdate(
          { userId, type: params.type, gameId, read: false },
          {
            $set: {
              userId,
              type: params.type,
              gameId,
              title: params.title,
              body: params.body,
              read: false,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true, new: true, timestamps: false },
        )
        .exec();
    } else {
      await this.notificationModel.create({
        userId,
        type: params.type,
        title: params.title,
        body: params.body,
        gameId,
      });
    }

    if (!this.pushEnabled) return;

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

  /** Permanently delete every notification row for the user ("clear all"). */
  async clearAll(userId: string): Promise<void> {
    await this.notificationModel
      .deleteMany({ userId: new Types.ObjectId(userId) })
      .exec();
  }
}