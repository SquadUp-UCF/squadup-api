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

/** State of a single player on a game's roster. */
export enum ParticipantStatus {
  Joined = 'joined',
  Cancelled = 'cancelled',
}

/**
 * A player on a game's roster. Stored inline (no own `_id`). Leaving a game
 * flips `status` to `cancelled` rather than removing the entry, so the roster
 * keeps its history; only `joined` participants count toward min/max.
 */
@Schema({ _id: false })
export class Participant {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({
    type: String,
    enum: ParticipantStatus,
    default: ParticipantStatus.Joined,
  })
  status: ParticipantStatus;

  @Prop({ type: Date, default: Date.now })
  joined_at: Date;
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

  @Prop({ type: [ParticipantSchema], default: [] })
  participants: Participant[];

  @Prop()
  photo_url?: string;
}

export const GameSchema = SchemaFactory.createForClass(Game);
