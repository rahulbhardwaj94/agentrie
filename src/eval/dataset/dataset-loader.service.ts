import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { Dataset } from '../eval.types';
import { parseDataset } from './dataset.schema';

/**
 * Loads + Zod-validates datasets from disk. Datasets live under `evals/datasets/`
 * as JSON; each is a versioned collection of cases. Validation happens on read so
 * a malformed case aborts before any agent runs (fail-fast, matching the env
 * loader's posture).
 *
 * Format note: JSON is the shipped on-disk format. YAML is a drop-in extension —
 * declare `js-yaml` and branch on the file extension here; the schema is identical.
 */
@Injectable()
export class DatasetLoader {
  private readonly logger = new Logger(DatasetLoader.name);

  /** Default on-disk root, relative to the repo. Overridable per call. */
  static readonly DEFAULT_ROOT = 'evals/datasets';

  /**
   * Load a dataset by id (filename without extension) or by explicit path.
   * `ref` may be `customer-support` (resolved under root) or `./path/to/file.json`.
   */
  async load(ref: string, root = DatasetLoader.DEFAULT_ROOT): Promise<Dataset> {
    const path = this.resolvePath(ref, root);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      throw new Error(
        `Dataset '${ref}' not found at ${path}: ${(err as Error).message}`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Dataset '${path}' is not valid JSON: ${(err as Error).message}`);
    }
    const dataset = parseDataset(raw, path);
    this.logger.log(
      `Loaded dataset '${dataset.id}' v${dataset.version} (${dataset.cases.length} cases) from ${path}`,
    );
    return dataset;
  }

  /** List dataset ids discoverable under the root (for `eval ls`/help). */
  async list(root = DatasetLoader.DEFAULT_ROOT): Promise<string[]> {
    try {
      const entries = await readdir(resolve(root));
      return entries
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  private resolvePath(ref: string, root: string): string {
    if (ref.endsWith('.json')) {
      return isAbsolute(ref) ? ref : resolve(ref);
    }
    return resolve(join(root, `${ref}.json`));
  }
}
