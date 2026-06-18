import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * MongoDB is the SOURCE OF TRUTH for session history; Redis is only the hot cache.
 * Every message that enters the Redis window is also written here.
 */

export type SessionStatus = 'active' | 'archived';

@Schema({ _id: false })
export class StoredToolCall {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) name!: string;
  @Prop({ type: Object, required: true }) input!: Record<string, unknown>;
}
const StoredToolCallSchema = SchemaFactory.createForClass(StoredToolCall);

@Schema({ _id: false })
export class StoredMessageDoc {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) role!: string;
  @Prop({ required: true }) content!: string;
  @Prop({ required: true }) tokenCount!: number;
  @Prop({ type: [StoredToolCallSchema], default: [] })
  toolCalls!: StoredToolCall[];
  @Prop({ required: true }) ts!: number;
}
const StoredMessageDocSchema = SchemaFactory.createForClass(StoredMessageDoc);

@Schema({ _id: false })
export class StoredSummaryDoc {
  @Prop({ required: true }) content!: string;
  @Prop({ required: true }) tokenCount!: number;
  /** Number of messages this summary condensed. */
  @Prop({ required: true }) replacedCount!: number;
  @Prop({ required: true }) ts!: number;
}
const StoredSummaryDocSchema = SchemaFactory.createForClass(StoredSummaryDoc);

@Schema({ collection: 'sessions', timestamps: true })
export class Session {
  @Prop({ required: true, unique: true, index: true })
  sessionId!: string;

  @Prop({ type: [StoredMessageDocSchema], default: [] })
  messages!: StoredMessageDoc[];

  @Prop({ type: [StoredSummaryDocSchema], default: [] })
  summaries!: StoredSummaryDoc[];

  @Prop({ default: 'active', enum: ['active', 'archived'], index: true })
  status!: SessionStatus;

  /**
   * Set when status flips to 'archived'. The TTL index below expires the doc
   * `SESSION_ARCHIVE_TTL_DAYS` after this time. Only archived docs carry it, so
   * active sessions never expire. (TTL configured at index-creation in the repo.)
   */
  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  // `createdAt` / `updatedAt` added by `timestamps: true`.
  createdAt!: Date;
  updatedAt!: Date;
}

export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);

// Indexes required by the spec: sessionId (above) + updatedAt for recency queries.
SessionSchema.index({ updatedAt: -1 });

// Config-driven TTL index on archived sessions. expireAfterSeconds is patched at
// runtime from SESSION_ARCHIVE_TTL_DAYS (see SessionRepository.ensureTtlIndex).
// partialFilterExpression ensures ONLY archived docs are subject to expiry.
SessionSchema.index(
  { archivedAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 30, // default 30d; overridden on boot
    partialFilterExpression: { status: 'archived' },
    name: 'archivedAt_ttl',
  },
);
