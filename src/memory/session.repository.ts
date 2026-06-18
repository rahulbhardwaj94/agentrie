import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppConfigService } from '../config/app-config.service';
import type { StoredMessage } from './memory-store.interface';
import {
  Session,
  type SessionDocument,
  type StoredSummaryDoc,
} from './schemas/session.schema';

/**
 * Durable session store (Mongo = source of truth). Handles message appends,
 * summary persistence, archival, and the config-driven TTL index.
 */
@Injectable()
export class SessionRepository implements OnModuleInit {
  private readonly logger = new Logger(SessionRepository.name);

  constructor(
    @InjectModel(Session.name)
    private readonly model: Model<SessionDocument>,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Patch the TTL index's expiry to the configured value on boot. The schema
   * declares the index; Mongo won't change `expireAfterSeconds` on an existing
   * index automatically, so we collMod it to keep TTL config-driven.
   */
  async onModuleInit(): Promise<void> {
    // Ensure the schema's indexes (incl. the archived-TTL index) exist first.
    await this.model.ensureIndexes().catch(() => undefined);
    try {
      // collMod the TTL index so expireAfterSeconds tracks SESSION_ARCHIVE_TTL_DAYS
      // (Mongo won't update an existing index's TTL automatically). Best-effort.
      const db = this.model.db.db;
      if (db) {
        await db.command({
          collMod: this.model.collection.collectionName,
          index: {
            name: 'archivedAt_ttl',
            expireAfterSeconds: this.config.sessionArchiveTtlSeconds,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not patch TTL index expiry: ${(err as Error).message}`,
      );
    }
  }

  async ensureSession(sessionId: string): Promise<void> {
    await this.model.updateOne(
      { sessionId },
      { $setOnInsert: { sessionId, status: 'active' } },
      { upsert: true },
    );
  }

  /** Append a message to the durable log (Mongo is written before/with Redis). */
  async appendMessage(
    sessionId: string,
    message: StoredMessage,
  ): Promise<void> {
    await this.model.updateOne(
      { sessionId },
      {
        $push: {
          messages: {
            id: message.id,
            role: message.role,
            content: message.content,
            tokenCount: message.tokenCount,
            toolCalls: message.toolCalls ?? [],
            ts: message.ts,
          },
        },
        $setOnInsert: { sessionId, status: 'active' },
      },
      { upsert: true },
    );
  }

  /** Persist a generated summary to the durable summaries[] array. */
  async appendSummary(
    sessionId: string,
    summary: StoredSummaryDoc,
  ): Promise<void> {
    await this.model.updateOne(
      { sessionId },
      { $push: { summaries: summary } },
    );
  }

  async getSession(sessionId: string): Promise<SessionDocument | null> {
    return this.model.findOne({ sessionId }).exec();
  }

  /** Flip a session to archived, stamping archivedAt so the TTL index applies. */
  async archive(sessionId: string): Promise<void> {
    await this.model.updateOne(
      { sessionId },
      { $set: { status: 'archived', archivedAt: new Date() } },
    );
  }
}
