/**
 * Mongoose schema for application users.
 *
 * Field names mirror the legacy Express `User` model (`first_name`, `last_name`,
 * `email`, `password`, timestamps) so existing documents remain valid without a
 * migration. New fields support features that are partially deferred — see the
 * inline notes for what is wired now vs. later.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

/** Lifecycle/verification state. `pending` until the school email is verified. */
export enum AccountStatus {
  Pending = 'pending',
  Active = 'active',
  Suspended = 'suspended',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  first_name: string;

  @Prop({ required: true })
  last_name: string;

  // Public handle. Unique across all users and required at registration.
  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ required: true, unique: true })
  email: string;

  // Argon2id hash. `select: false` keeps it out of query results unless a query
  // explicitly asks for it (e.g. during login).
  @Prop({ required: true, select: false })
  password: string;

  // Float rating set when players rate each other before/after a match.
  // New users start at 5.0 (benefit of the doubt) on a 0.0–5.0 scale.
  @Prop({ default: 5.0, min: 0, max: 5 })
  reputation: number;

  // Count of matches the player failed to show up for.
  @Prop({ default: 0 })
  no_show_count: number;

  // Derived "flaker" flag, toggled later once no_show_count crosses a threshold.
  @Prop({ default: false })
  is_flaker: boolean;

  // Reports for trash talk / dirty play. Suspend-at-10 logic lands with the
  // reputation module; for now this is just the counter.
  @Prop({ default: 0 })
  reputation_reports: number;

  // Single source of truth for suspension/verification state.
  @Prop({
    type: String,
    enum: AccountStatus,
    default: AccountStatus.Pending,
  })
  account_status: AccountStatus;

  // Games hosted by this user. Fully wired once the Game schema exists.
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Game' }], default: [] })
  games_created: Types.ObjectId[];

  // Games this user has joined. Fully wired once the Game schema exists.
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Game' }], default: [] })
  games_joined: Types.ObjectId[];

  // Soft-delete marker. When set, the account is treated as deleted (login
  // blocked) but the document is retained.
  @Prop({ type: Date, default: null })
  deleted_at: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
