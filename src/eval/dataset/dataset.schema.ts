import { z } from 'zod';

/**
 * Zod schemas for the on-disk dataset format. Datasets are validated on read so a
 * malformed case fails loudly at load time, not mid-run. Mirrors the TS types in
 * `eval.types.ts` (those stay the hand-written, documented source; these are the
 * runtime gate).
 */

const terminalStatus = z.enum([
  'completed',
  'max_iterations',
  'max_tool_calls',
  'timeout',
  'error',
]);

export const evalRunRequestSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  guardrails: z
    .object({
      maxIterations: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export const evalExpectedSchema = z
  .object({
    equals: z.string().optional(),
    contains: z.array(z.string().min(1)).optional(),
    numeric: z
      .object({
        value: z.number(),
        tolerance: z.number().min(0),
      })
      .optional(),
    rubric: z.string().min(1).optional(),
    status: terminalStatus.optional(),
  })
  .refine(
    (e) =>
      e.equals !== undefined ||
      e.contains !== undefined ||
      e.numeric !== undefined ||
      e.rubric !== undefined ||
      e.status !== undefined,
    { message: 'expected must declare at least one criterion' },
  );

export const evalConstraintsSchema = z.object({
  mustNotCallTools: z.array(z.string().min(1)).optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxIterations: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  input: evalRunRequestSchema,
  expected: evalExpectedSchema,
  tags: z.array(z.string()).optional(),
  constraints: evalConstraintsSchema.optional(),
  requiredScorers: z.array(z.string().min(1)).optional(),
});

export const datasetSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(evalCaseSchema).min(1),
});

export type DatasetInput = z.infer<typeof datasetSchema>;

/**
 * Validate a parsed object as a Dataset, raising a readable aggregate error.
 * Also enforces case-id uniqueness (Zod can't express that across the array).
 */
export function parseDataset(raw: unknown, source: string): DatasetInput {
  const parsed = datasetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid dataset '${source}':\n${issues}`);
  }
  const ids = new Set<string>();
  for (const c of parsed.data.cases) {
    if (ids.has(c.id)) {
      throw new Error(`Invalid dataset '${source}': duplicate case id '${c.id}'`);
    }
    ids.add(c.id);
  }
  return parsed.data;
}
