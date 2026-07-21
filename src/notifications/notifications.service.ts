import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  async sendToUser(params: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    gameId?: string;
  }): Promise<void> {
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

  /**
   * Delete a single row from the caller's history. Scoped by `userId` so a
   * guessed id can't remove someone else's notification; a miss is a no-op
   * rather than an error, which keeps the client's optimistic removal (and any
   * retry of it) idempotent.
   */
  async remove(notificationId: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(notificationId)) return;
    await this.notificationModel
      .deleteOne({ _id: notificationId, userId: new Types.ObjectId(userId) })
      .exec();
  }

  /** Permanently delete every notification row for the user ("clear all"). */
  async clearAll(userId: string): Promise<void> {
    await this.notificationModel
      .deleteMany({ userId: new Types.ObjectId(userId) })
      .exec();
  }
}