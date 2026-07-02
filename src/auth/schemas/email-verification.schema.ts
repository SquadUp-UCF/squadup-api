/**
 * One-time email verification code, issued after registration.
 *
 * The code itself is never stored — only its Argon2id hash — so a database
 * leak does not expose live codes. `attempts` counts failed guesses so a code
 * can be invalidated after too many tries, and the TTL index removes expired
 * documents automatically.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailVerificationDocument = EmailVerification &
  Document & { createdAt: Date };

@Schema({ timestamps: true })
export class EmailVerification {
  @Prop({ required: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  code_hash: string;

  @Prop({ required: true })
  expires_at: Date;

  @Prop({ default: false })
  used: boolean;

  @Prop({ default: 0 })
  attempts: number;
}

export const EmailVerificationSchema =
  SchemaFactory.createForClass(EmailVerification);
EmailVerificationSchema.index({ email: 1, used: 1, expires_at: 1 });
EmailVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
