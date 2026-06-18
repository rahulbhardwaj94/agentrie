import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppConfigService } from '../config/app-config.service';
import { SpanCollector } from './span-collector.service';
import { DatasetLoader } from './dataset/dataset-loader.service';
import { EvalCompareService } from './eval-compare.service';
import { EvalRunnerService } from './eval-runner.service';
import type {
  AgentConfigOverride,
  CompareResult,
  EvalRunRecord,
} from './eval.types';
import {
  evaluateCompareGates,
  evaluateRunGates,
  parseThreshold,
  type CompareGates,
  type GateVerdict,
  type RunGates,
} from './gating';
import { ReportService } from './report/report.service';

/**
 * Eval CLI — `eval run <dataset>` and `eval compare <dataset> ...`.
 *
 * Runs the whole suite on the keyless FakeLlmProvider by default. Output is BOTH
 * human-readable (console tables) AND machine-readable (a JSON artifact, for
 * future CI gating), plus an optional self-contained HTML report.
 *
 *   npm run eval -- run seed
 *   npm run eval -- run seed --report
 *   npm run eval -- compare seed --baseline default --candidate '{"maxToolCalls":8,"label":"loose"}'
 *   npm run eval -- compare seed --baseline <runId> --candidate '{"maxIterations":1}'
 *
 * Requires Redis + Mongo (docker compose up -d): the AgentRunner uses the real
 * memory store and runs are persisted to Mongo.
 */
async function main(): Promise<void> {
  const logger = new Logger('EvalCLI');
  const [command, ...rest] = process.argv.slice(2);

  if (!command || !['run', 'compare'].includes(command)) {
    printUsage();
    process.exitCode = command ? 1 : 0;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const loader = app.get(DatasetLoader);
    const config = app.get(AppConfigService);
    const reports = app.get(ReportService);

    const datasetRef = rest[0];
    if (!datasetRef) throw new Error('missing <dataset> argument');
    const flags = parseFlags(rest.slice(1));
    const dataset = await loader.load(datasetRef);

    if (command === 'run') {
      const runner = app.get(EvalRunnerService);
      const record = await runner.run(dataset, {});
      printRun(record);
      await emitArtifacts('run', record, flags, config, reports);
      // CI gate: fail the build if the run dips under a configured floor.
      const verdict = evaluateRunGates(record, runGatesFromFlags(flags));
      printGateVerdict('run', verdict);
      if (!verdict.passed) process.exitCode = verdict.exitCode;
    } else {
      const compare = app.get(EvalCompareService);
      const baselineRef = flags['baseline'] ?? 'default';
      const candidateRef = flags['candidate'] ?? 'default';
      const candidate = parseOverride(candidateRef, 'candidate');

      const result = isRunId(baselineRef)
        ? await compare.compareToBaselineRun(dataset, baselineRef, candidate)
        : await compare.compareConfigs(
            dataset,
            parseOverride(baselineRef, 'baseline'),
            candidate,
          );
      printCompare(result);
      await emitArtifacts('compare', result, flags, config, reports);
      // CI gate: regressions fail by default; aggregate/pass-rate drops fail past
      // their budgets. Exit code distinguishes a compare gate (2) from a run gate (3).
      const verdict = evaluateCompareGates(result, compareGatesFromFlags(flags));
      printGateVerdict('compare', verdict);
      if (!verdict.passed) process.exitCode = verdict.exitCode;
    }
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await app.get(SpanCollector).shutdown();
    await app.close();
  }
}

// --- argument parsing -------------------------------------------------------

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

/** Map gate flags onto RunGates (thresholds accept a fraction or a percent). */
function runGatesFromFlags(flags: Record<string, string>): RunGates {
  const gates: RunGates = {};
  if (flags['min-score']) gates.minScore = parseThreshold(flags['min-score']);
  if (flags['min-pass-rate'])
    gates.minPassRate = parseThreshold(flags['min-pass-rate']);
  return gates;
}

/** Map gate flags onto CompareGates. */
function compareGatesFromFlags(flags: Record<string, string>): CompareGates {
  const gates: CompareGates = {};
  if (flags['max-aggregate-drop'])
    gates.maxAggregateDrop = parseThreshold(flags['max-aggregate-drop']);
  if (flags['max-pass-rate-drop'])
    gates.maxPassRateDrop = parseThreshold(flags['max-pass-rate-drop']);
  if (flags['allow-regressions'] === 'true') gates.allowRegressions = true;
  return gates;
}

function printGateVerdict(kind: 'run' | 'compare', verdict: GateVerdict): void {
  const w = process.stdout;
  if (verdict.passed) {
    w.write(`  ✓ ${kind} gate passed\n\n`);
    return;
  }
  w.write(`  ✗ ${kind} gate FAILED (exit ${verdict.exitCode}):\n`);
  for (const f of verdict.failures) w.write(`    - ${f}\n`);
  w.write('\n');
}

/** A run id looks like `<dataset>-<ts>-<hex>`; anything JSON or 'default' is a config. */
function isRunId(ref: string): boolean {
  return ref !== 'default' && !ref.trim().startsWith('{') && /-\d{10,}-/.test(ref);
}

function parseOverride(ref: string, label: string): AgentConfigOverride {
  if (ref === 'default') return { label };
  if (ref.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(ref) as AgentConfigOverride;
      return { label, ...obj };
    } catch (err) {
      throw new Error(`invalid ${label} config JSON: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `${label} must be 'default', a JSON override, or (baseline only) a run id`,
  );
}

// --- console output ---------------------------------------------------------

function printRun(record: EvalRunRecord): void {
  const w = process.stdout;
  w.write(`\n  Eval: ${record.datasetId} v${record.datasetVersion}  [${record.config.provider}/${record.config.model}, ${record.config.label}]\n`);
  w.write(`  run ${record.runId}\n\n`);
  w.write(pad('CASE', 26) + pad('STATUS', 16) + pad('SCORE', 8) + 'RESULT\n');
  w.write('  ' + '-'.repeat(70) + '\n');
  for (const c of record.caseResults) {
    const failed = c.scores.filter((s) => !s.pass && !s.unavailable).map((s) => s.name);
    const note = c.pass ? '' : `✗ ${failed.join(', ') || c.error || ''}`;
    w.write(
      pad(c.caseId, 26) +
        pad(c.status, 16) +
        pad((c.score * 100).toFixed(0) + '%', 8) +
        `${c.pass ? 'PASS' : 'FAIL'} ${note}\n`,
    );
  }
  w.write('  ' + '-'.repeat(70) + '\n');
  const passed = record.caseResults.filter((c) => c.pass).length;
  w.write(
    `  AGGREGATE ${(record.aggregateScore * 100).toFixed(1)}%   ` +
      `PASS RATE ${(record.passRate * 100).toFixed(1)}% (${passed}/${record.caseResults.length})\n\n`,
  );
}

function printCompare(r: CompareResult): void {
  const w = process.stdout;
  w.write(`\n  Compare: ${r.datasetId} v${r.datasetVersion}\n`);
  w.write(`  baseline  ${r.baseline.label}  agg ${(r.baseline.aggregateScore * 100).toFixed(1)}%  pass ${(r.baseline.passRate * 100).toFixed(1)}%  (${r.baseline.runId})\n`);
  w.write(`  candidate ${r.candidate.label}  agg ${(r.candidate.aggregateScore * 100).toFixed(1)}%  pass ${(r.candidate.passRate * 100).toFixed(1)}%  (${r.candidate.runId})\n\n`);
  const sign = r.aggregateDelta >= 0 ? '▲' : '▼';
  w.write(`  ${sign} aggregate ${signPP(r.aggregateDelta)}   pass-rate ${signPP(r.passRateDelta)}\n\n`);

  if (r.regressions.length) {
    w.write(`  ⚠ REGRESSIONS (${r.regressions.length}):\n`);
    for (const d of r.regressions) {
      const moved = d.scorerMoves
        .map((m) => `${m.name} ${m.baselinePass ? 'pass' : 'fail'}→${m.candidatePass ? 'pass' : 'fail'}`)
        .join('; ');
      w.write(`    ✗ ${pad(d.caseId, 24)} ${signPP(d.scoreDelta)}  [${moved}]\n`);
    }
    w.write('\n');
  } else {
    w.write('  ✓ no regressions\n\n');
  }
  if (r.improvements.length) {
    w.write(`  ✓ improvements (${r.improvements.length}): ${r.improvements.map((d) => d.caseId).join(', ')}\n\n`);
  }
}

// --- artifacts (JSON + optional HTML) --------------------------------------

async function emitArtifacts(
  kind: 'run' | 'compare',
  payload: EvalRunRecord | CompareResult,
  flags: Record<string, string>,
  config: AppConfigService,
  reports: ReportService,
): Promise<void> {
  const w = process.stdout;
  const id =
    kind === 'run'
      ? (payload as EvalRunRecord).runId
      : `${(payload as CompareResult).baseline.runId}-vs-${(payload as CompareResult).candidate.runId}`;

  // Always write the machine-readable JSON artifact.
  const jsonPath = resolve(config.evalReportDir, `${kind}-${id}.json`);
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8').catch(
    () => undefined,
  );
  w.write(`  json:   ${jsonPath}\n`);

  if (flags['json'] === 'true') {
    w.write(JSON.stringify(payload) + '\n');
  }

  if (flags['report'] === 'true') {
    const path =
      kind === 'run'
        ? await reports.writeRunReport(payload as EvalRunRecord)
        : await reports.writeCompareReport(payload as CompareResult);
    w.write(`  report: ${path}\n`);
  }
  w.write('\n');
}

function printUsage(): void {
  process.stdout.write(
    `\nagentrie eval CLI\n\n` +
      `  eval run <dataset> [--report] [--json]\n` +
      `      [--min-score <0..1|pct>] [--min-pass-rate <0..1|pct>]\n` +
      `  eval compare <dataset> --baseline <runId|default|json> --candidate <default|json> [--report] [--json]\n` +
      `      [--max-aggregate-drop <0..1|pct>] [--max-pass-rate-drop <0..1|pct>] [--allow-regressions]\n\n` +
      `CI gating (exit codes): 0 pass · 1 error · 2 compare-gate fail · 3 run-gate fail\n\n` +
      `examples:\n` +
      `  npm run eval -- run seed --report\n` +
      `  npm run eval -- run seed --min-score 0.7 --min-pass-rate 60   # gate a run in CI\n` +
      `  npm run eval -- compare seed --baseline default --candidate '{"maxToolCalls":8,"label":"loose"}'\n` +
      `  npm run eval -- compare seed --baseline default --candidate '{"tools":{"deny":["read_file"]},"label":"no-fs"}'  # vary the tool set\n` +
      `  npm run eval -- compare seed --baseline <runId> --candidate default --max-aggregate-drop 2  # tolerate <=2pp\n\n`,
  );
}

function pad(s: string, n: number): string {
  const t = s.length > n - 1 ? s.slice(0, n - 2) + '…' : s;
  return ('  ' + t).padEnd(n);
}

function signPP(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}pp`;
}

void main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
