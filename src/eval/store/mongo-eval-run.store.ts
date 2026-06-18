import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { EvalRunRecord } from '../eval.types';
import type { EvalRunStore } from './eval-run-store.interface';
import { EvalRun, type EvalRunDocument } from './schemas/eval-run.schema';

/** Mongo-backed EvalRunStore — the durable record compare mode diffs against. */
@Injectable()
export class MongoEvalRunStore implements EvalRunStore {
  constructor(
    @InjectModel(EvalRun.name)
    private readonly model: Model<EvalRunDocument>,
  ) {}

  async save(record: EvalRunRecord): Promise<void> {
    await this.model.updateOne(
      { runId: record.runId },
      { $set: record },
      { upsert: true },
    );
  }

  async getById(runId: string): Promise<EvalRunRecord | null> {
    const doc = await this.model.findOne({ runId }).lean().exec();
    return doc ? this.toRecord(doc) : null;
  }

  async findLatest(
    datasetId: string,
    configLabel?: string,
  ): Promise<EvalRunRecord | null> {
    const filter: Record<string, unknown> = { datasetId };
    if (configLabel) filter['config.label'] = configLabel;
    const doc = await this.model
      .findOne(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return doc ? this.toRecord(doc) : null;
  }

  private toRecord(doc: Record<string, unknown>): EvalRunRecord {
    // `lean()` returns the stored shape; strip Mongo bookkeeping fields.
    const { _id, __v, updatedAt, ...rest } = doc as Record<string, unknown> & {
      _id?: unknown;
      __v?: unknown;
      updatedAt?: unknown;
    };
    void _id;
    void __v;
    void updatedAt;
    return rest as unknown as EvalRunRecord;
  }
}
