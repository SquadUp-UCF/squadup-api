/**
 * Mongoose schema for pickup games.
 *
 * Ports the legacy Express `Game` model (`models/Game.js`) into the
 * `@nestjs/mongoose` decorator style. Field names and the collection are kept
 * identical so existing documents remain valid without a migration.
 *
 * A game moves through `open → confirmed → locked` as its roster fills, and can
 * end in the terminal states `completed` or `cancelled`. The host is auto-added
 * to the roster on creation and counts toward the player thresholds.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GameDocument = HydratedDocument<Game>;

/** Lifecycle of a game. `completed` and `cancelled` are terminal. */
export enum GameStatus {
  Open = 'open',
  Confirmed = 'confirmed',
  Locked = 'locked',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

/**
 * Target skill level for a game, so players can find matches that fit them.
 * `all` (the default) means the host welcomes any level; the others mirror the
 * per-user skill vocabulary used elsewhere in the product.
 */
export enum GameSkillLevel {
  All = 'all',
  Beginner = 'beginner',
  Intermediate = 'intermediate',
  Pro = 'pro',
}

/** State of a single player on a game's roster. */
export enum ParticipantStatus {
  Joined = 'joined',
  Cancelled = 'cancelled',
}

/**
 * A player on a game's roster. Stored inline (no own `_id`). Leaving a game
 * flips `status` to `cancelled` rather than removing the entry, so the roster
 * keeps its history; only `joined` participants count toward min/max.
 *
 * A participant is either a registered user (`user` set) or a guest the host
 * pre-added by name (`name` set, no account) — so a host can seed the roster
 * with people who may not use the app. Exactly one of `user`/`name` is present.
 */
@Schema({ _id: false })
export class Participant {
  // Set for registered players. Absent for guests (see `name`).
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  user?: Types.ObjectId;

  // Display name for a guest player with no account. Absent for registered
  // players (their identity comes from `user`).
  @Prop({ type: String })
  name?: string;

  // Optional sport-specific position this player is filling (free text, e.g.
  // "Goalkeeper"). Currently set for pre-added guests.
  @Prop({ type: String })
  position?: string;

  // For a guest, the account that put them on the roster — the host who
  // pre-added them, or the player who brought them along. Without it a guest
  // can't be traced back to anyone, so a player leaving would strand the
  // guests they brought on the roster with no way to remove them.
  // Absent on registered players (they are their own entry) and on guests
  // created before this field existed.
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  added_by?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ParticipantStatus,
    default: ParticipantStatus.Joined,
  })
  status: ParticipantStatus;

  @Prop({ type: Date, default: Date.now })
  joined_at: Date;

  // Headcount this join represents, including the joining user themselves —
  // lets one account RSVP for a group (e.g. "3" means them + 2 friends) rather
  // than requiring every attendee to have their own account. Counts toward
  // min/max thresholds in place of a flat 1-per-participant count.
  @Prop({ default: 1, min: 1 })
  party_size: number;
}

export const ParticipantSchema = SchemaFactory.createForClass(Participant);

@Schema({ timestamps: true })
export class Game {
  // The organizer. Also auto-added to `participants` on creation.
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  host: Types.ObjectId;

  @Prop({ required: true })
  sport: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  location: string;

  @Prop({ type: Date, required: true })
  start_time: Date;

  @Prop({ required: true })
  latitude: number;

  @Prop({ required: true })
  longitude: number;

  // Active roster reaching this many players flips the game to `confirmed`.
  @Prop({ required: true })
  min_players: number;

  // Active roster reaching this many players flips the game to `locked` (full).
  @Prop({ required: true })
  max_players: number;

  @Prop({
    type: String,
    enum: GameStatus,
    default: GameStatus.Open,
  })
  status: GameStatus;

  // Target skill level for the game. Defaults to `all` (open to any level).
  @Prop({
    type: String,
    enum: GameSkillLevel,
    default: GameSkillLevel.All,
  })
  skill_level: GameSkillLevel;

  @Prop({ type: [ParticipantSchema], default: [] })
  participants: Participant[];

  @Prop()
  photo_url?: string;

<<<<<<< HEAD
  // Users who have already submitted post-game ratings for this game — lets
  // `GET /games/pending-ratings` skip games a caller already rated, and blocks
  // a second submission from the same rater.
=======
  // Users who have submitted their player ratings for this (completed) game.
  // Prevents double-rating and drives the "games awaiting your rating" prompt.
>>>>>>> 9dc8722731ef18d5fcb84271b24c3d72aff44029
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  rated_by: Types.ObjectId[];
}

export const GameSchema = SchemaFactory.createForClass(Game);
