import type { EvalRunRecord } from '../eval.types';

/**
 * Persistence seam for eval runs (mirrors the MemoryStore/LockService pattern:
 * an interface + DI token, with a Mongo-backed implementation in the module and a
 * trivial in-memory one for tests). Compare mode reads baseline runs back through
 * this seam.
 */
export interface EvalRunStore {
  /** Persist a completed run. */
  save(record: EvalRunRecord): Promise<void>;
  /** Fetch a run by its id (compare mode `--baseline <runId>`). */
  getById(runId: string): Promise<EvalRunRecord | null>;
  /** Most recent run for a dataset (optionally filtered by config label). */
  findLatest(
    datasetId: string,
    configLabel?: string,
  ): Promise<EvalRunRecord | null>;
}

export const EVAL_RUN_STORE = Symbol('EVAL_RUN_STORE');
