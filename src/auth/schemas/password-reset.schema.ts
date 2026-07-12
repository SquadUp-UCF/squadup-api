/**
 * One-time password-reset token, issued by `forgot-password`.
 *
 * The token itself is never stored — only its SHA-256 hash — so a database
 * leak does not expose live reset links. Unlike the 6-digit verification code,
 * the token is 32 bytes of CSPRNG output and so has no brute-force surface
 * worth defending with a memory-hard KDF; a plain SHA-256 makes the stored
 * value useless to an attacker while keeping the token indexable. (Argon2
 * hashes are salted, so they cannot be looked up by hash — hence the different
 * choice here than in `email-verification.schema.ts`.)
 *
 * The TTL index removes expired documents automatically.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PasswordResetDocument = PasswordReset &
  Document & { createdAt: Date };

@Schema({ timestamps: true })
export class PasswordReset {
  @Prop({ required: true, lowercase: true })
  email: string;

  @Prop({ required: true, unique: true })
  token_hash: string;

  @Prop({ required: true })
  expires_at: Date;

  @Prop({ default: false })
  used: boolean;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);
PasswordResetSchema.index({ email: 1, used: 1, expires_at: 1 });
PasswordResetSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
