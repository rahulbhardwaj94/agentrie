import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type {
  CaseResult,
  ConfigFingerprint,
} from '../../eval.types';

/**
 * Persisted eval run (`eval_runs` collection). This is what compare mode diffs
 * against. The nested per-case results + span trees are stored as Mixed — they are
 * read-back-whole artifacts (for the report and compare), not queried field-wise,
 * so a strict sub-schema would add ceremony without value (same call the audit
 * `input: Record<string, unknown>` makes in the session schema).
 */
@Schema({ collection: 'eval_runs', timestamps: true })
export class EvalRun {
  @Prop({ required: true, unique: true, index: true })
  runId!: string;

  @Prop({ required: true, index: true })
  datasetId!: string;

  @Prop({ required: true })
  datasetVersion!: string;

  @Prop({ type: Object, required: true })
  config!: ConfigFingerprint;

  @Prop({ required: true })
  aggregateScore!: number;

  @Prop({ required: true })
  passRate!: number;

  @Prop({ type: Array, default: [] })
  caseResults!: CaseResult[];

  @Prop({ required: true })
  createdAt!: string;
}

export type EvalRunDocument = HydratedDocument<EvalRun>;
export const EvalRunSchema = SchemaFactory.createForClass(EvalRun);

// Recency lookups for `findLatest` (compare mode baseline resolution).
EvalRunSchema.index({ datasetId: 1, createdAt: -1 });
