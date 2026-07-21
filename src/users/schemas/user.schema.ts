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

  // Relative URL path to the user's uploaded avatar, e.g.
  // `/uploads/avatars/<id>.jpg`, served as a static file. The bytes live on
  // disk; only this path is stored on the row. Null when no picture is set.
  @Prop({ type: String, default: null })
  profile_picture: string | null;

  // Argon2id hash. `select: false` keeps it out of query results unless a query
  // explicitly asks for it (e.g. during login).
  @Prop({ required: true, select: false })
  password: string;

  // When the password was last reset. `JwtStrategy` refuses any token issued
  // before this instant, so a reset revokes every session that was already
  // open. Null for accounts that have never reset — their tokens all stand.
  @Prop({ type: Date, default: null })
  password_changed_at: Date | null;

  // Float rating set when players rate each other before/after a match.
  // New users start at 5.0 (benefit of the doubt) on a 0.0–5.0 scale.
  @Prop({ default: 5.0, min: 0, max: 5 })
  reputation: number;

  // Single source of truth for suspension/verification state.
  @Prop({
    type: String,
    enum: AccountStatus,
    default: AccountStatus.Pending,
  })
  account_status: AccountStatus;

  // Self-reported skill level per sport, keyed by sport (e.g.
  // { soccer: 'Intermediate' }). The canonical skill store. Free text.
  @Prop({ type: Map, of: String, default: {} })
  skill_levels: Map<string, string>;

  // Games hosted by this user. Fully wired once the Game schema exists.
  //
  // NOTE: the array element type + `ref` must be declared as SIBLING keys
  // (`{ type: [Types.ObjectId], ref: 'Game' }`), not nested
  // (`{ type: [{ type: Types.ObjectId, ref: 'Game' }] }`). The nested form
  // compiles "successfully" with no error, but `@nestjs/mongoose`'s `@Prop`
  // decorator silently mis-casts it: the array's caster ends up `Mixed`
  // instead of `ObjectId`, and `ref` is dropped entirely — so `$addToSet`
  // stores whatever type was handed to it (often a raw string) instead of
  // casting to `ObjectId`, and `.populate()` on the field silently no-ops
  // rather than throwing. Confirmed by isolated repro against this exact
  // mongoose/@nestjs-mongoose version pair; verified this sibling form's
  // `.populate()` actually resolves real documents before relying on it in
  // `UsersService.getSavedGames()`.
  @Prop({ type: [Types.ObjectId], ref: 'Game', default: [] })
  games_created: Types.ObjectId[];

  // Games this user has joined. Fully wired once the Game schema exists.
  @Prop({ type: [Types.ObjectId], ref: 'Game', default: [] })
  games_joined: Types.ObjectId[];

  // Games the user bookmarked ("saved") to follow without joining the roster.
  // Distinct from games_joined: saving never affects a game's headcount.
  @Prop({ type: [Types.ObjectId], ref: 'Game', default: [] })
  saved_games: Types.ObjectId[];

  // Soft-delete marker. When set, the account is treated as deleted (login
  // blocked) but the document is retained.
  @Prop({ type: Date, default: null })
  deleted_at: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
