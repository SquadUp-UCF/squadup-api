import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DeviceTokenDocument = HydratedDocument<DeviceToken>;

@Schema({ timestamps: true })
export class DeviceToken {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  token: string;

  @Prop({ default: 'ios', enum: ['ios', 'android'] })
  platform: string;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);
DeviceTokenSchema.index({ userId: 1, token: 1 }, { unique: true });