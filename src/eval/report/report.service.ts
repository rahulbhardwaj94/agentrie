import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { GenAiAttr } from '../../observability/tracing.service';
import type {
  CapturedSpan,
  CaseResult,
  CompareResult,
  EvalRunRecord,
  ScoreResult,
} from '../eval.types';

/**
 * Self-contained HTML report generator (static file, no server). This is the
 * "traced + measured" story made visible: every case row shows pass/fail per
 * scorer AND an inline view of the run's span tree, so a failure links straight to
 * the trace that explains it.
 */
@Injectable()
export class ReportService {
  constructor(private readonly config: AppConfigService) {}

  /** Render + write a run report. Returns the absolute file path. */
  async writeRunReport(record: EvalRunRecord): Promise<string> {
    const html = this.renderRun(record);
    return this.write(`run-${record.runId}.html`, html);
  }

  /** Render + write a compare report. Returns the absolute file path. */
  async writeCompareReport(cmp: CompareResult): Promise<string> {
    const html = this.renderCompare(cmp);
    const name = `compare-${cmp.baseline.runId}-vs-${cmp.candidate.runId}.html`;
    return this.write(name, html);
  }

  private async write(filename: string, html: string): Promise<string> {
    const dir = resolve(this.config.evalReportDir);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, filename);
    await writeFile(path, html, 'utf8');
    return path;
  }

  // --- Run report -----------------------------------------------------------

  renderRun(record: EvalRunRecord): string {
    const rows = record.caseResults.map((c) => this.caseSection(c)).join('\n');
    const passCount = record.caseResults.filter((c) => c.pass).length;
    const header = `
      <header>
        <h1>Eval Report — ${esc(record.datasetId)} <span class="ver">v${esc(record.datasetVersion)}</span></h1>
        <div class="meta">
          <span>run <code>${esc(record.runId)}</code></span>
          <span>${esc(record.config.provider)}/${esc(record.config.model)}</span>
          <span>config <strong>${esc(record.config.label)}</strong></span>
          <span>${esc(record.createdAt)}</span>
        </div>
        <div class="scorecards">
          ${scorecard('Aggregate score', pct(record.aggregateScore), record.aggregateScore >= 0.7)}
          ${scorecard('Pass rate', pct(record.passRate), record.passRate >= 0.7)}
          ${scorecard('Cases passed', `${passCount} / ${record.caseResults.length}`, passCount === record.caseResults.length)}
        </div>
      </header>`;
    return this.page(`Eval — ${record.datasetId}`, header + `<main>${rows}</main>`);
  }

  private caseSection(c: CaseResult): string {
    const badge = c.pass ? pill('PASS', 'ok') : pill('FAIL', 'bad');
    const scorers = c.scores.length
      ? `<table class="scorers">
          <thead><tr><th>scorer</th><th>score</th><th>verdict</th><th>detail</th></tr></thead>
          <tbody>${c.scores.map((s) => this.scorerRow(s)).join('')}</tbody>
         </table>`
      : `<p class="muted">No scorers applied to this case.</p>`;
    const errLine = c.error
      ? `<p class="err">error: ${esc(c.error)}</p>`
      : '';
    const tags = (c.tags ?? [])
      .map((t) => `<span class="tag">${esc(t)}</span>`)
      .join('');
    return `
      <section class="case ${c.pass ? 'p' : 'f'}">
        <details ${c.pass ? '' : 'open'}>
          <summary>
            ${badge}
            <span class="cid">${esc(c.caseId)}</span>
            <span class="status">${esc(c.status)}</span>
            <span class="cscore">${pct(c.score)}</span>
            ${tags}
          </summary>
          <div class="answer"><strong>answer:</strong> ${esc(c.answer || '∅')}</div>
          ${errLine}
          ${scorers}
          <div class="trace">
            <h4>span tree</h4>
            ${this.spanTree(c.spanTree)}
          </div>
        </details>
      </section>`;
  }

  private scorerRow(s: ScoreResult): string {
    const verdict = s.unavailable
      ? pill('N/A', 'na')
      : s.pass
        ? pill('pass', 'ok')
        : pill('fail', 'bad');
    return `<tr>
      <td><code>${esc(s.name)}</code></td>
      <td>${s.unavailable ? '—' : pct(s.score)}</td>
      <td>${verdict}</td>
      <td class="detail">${esc(s.detail)}</td>
    </tr>`;
  }

  private spanTree(spans: CapturedSpan[]): string {
    if (!spans.length) return `<p class="muted">No spans captured.</p>`;
    const render = (s: CapturedSpan): string => {
      const statusCls =
        s.status === 'error' ? 'bad' : s.status === 'ok' ? 'ok' : 'na';
      const attrs = this.spanAttrs(s);
      const kids = s.children.length
        ? `<ul>${s.children.map(render).join('')}</ul>`
        : '';
      return `<li>
        <span class="span-dot ${statusCls}"></span>
        <code class="span-name">${esc(s.name)}</code>
        <span class="span-dur">${s.durationMs.toFixed(1)}ms</span>
        ${attrs}
        ${kids}
      </li>`;
    };
    return `<ul class="spantree">${spans.map(render).join('')}</ul>`;
  }

  private spanAttrs(s: CapturedSpan): string {
    const chips: string[] = [];
    const tool = s.attributes[GenAiAttr.TOOL_NAME];
    const model = s.attributes[GenAiAttr.REQUEST_MODEL];
    const inTok = s.attributes[GenAiAttr.USAGE_INPUT_TOKENS];
    const outTok = s.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS];
    if (tool !== undefined) chips.push(`tool=${esc(String(tool))}`);
    if (model !== undefined) chips.push(`model=${esc(String(model))}`);
    if (inTok !== undefined || outTok !== undefined) {
      chips.push(`tok=${esc(String(inTok ?? 0))}/${esc(String(outTok ?? 0))}`);
    }
    if (s.statusMessage) chips.push(`err=${esc(s.statusMessage)}`);
    return chips.map((c) => `<span class="attr">${c}</span>`).join('');
  }

  // --- Compare report -------------------------------------------------------

  renderCompare(cmp: CompareResult): string {
    const aggCls = cmp.aggregateDelta >= 0 ? 'ok' : 'bad';
    const header = `
      <header>
        <h1>Compare — ${esc(cmp.datasetId)} <span class="ver">v${esc(cmp.datasetVersion)}</span></h1>
        <div class="meta">
          <span>baseline <strong>${esc(cmp.baseline.label)}</strong> <code>${esc(cmp.baseline.runId)}</code></span>
          <span>candidate <strong>${esc(cmp.candidate.label)}</strong> <code>${esc(cmp.candidate.runId)}</code></span>
        </div>
        <div class="scorecards">
          ${scorecard('Aggregate', `${pct(cmp.baseline.aggregateScore)} → ${pct(cmp.candidate.aggregateScore)}`, cmp.aggregateDelta >= 0, delta(cmp.aggregateDelta))}
          ${scorecard('Pass rate', `${pct(cmp.baseline.passRate)} → ${pct(cmp.candidate.passRate)}`, cmp.passRateDelta >= 0, delta(cmp.passRateDelta))}
          ${scorecard('Regressions', String(cmp.regressions.length), cmp.regressions.length === 0)}
          ${scorecard('Improvements', String(cmp.improvements.length), true)}
        </div>
        <p class="bigdelta ${aggCls}">${cmp.aggregateDelta >= 0 ? '▲' : '▼'} ${delta(cmp.aggregateDelta)} aggregate</p>
      </header>`;

    const regBlock = cmp.regressions.length
      ? `<section class="block reg">
          <h2>⚠ Regressions (${cmp.regressions.length})</h2>
          ${cmp.regressions.map((d) => this.diffRow(d)).join('')}
         </section>`
      : `<section class="block"><h2>No regressions 🎉</h2></section>`;

    const impBlock = cmp.improvements.length
      ? `<section class="block imp">
          <h2>Improvements (${cmp.improvements.length})</h2>
          ${cmp.improvements.map((d) => this.diffRow(d)).join('')}
         </section>`
      : '';

    const allBlock = `<section class="block">
        <h2>All cases</h2>
        <table class="diff">
          <thead><tr><th>case</th><th>baseline</th><th>candidate</th><th>Δscore</th><th>moved scorers</th></tr></thead>
          <tbody>${cmp.cases.map((d) => this.diffTableRow(d)).join('')}</tbody>
        </table>
      </section>`;

    return this.page(
      `Compare — ${cmp.datasetId}`,
      header + `<main>${regBlock}${impBlock}${allBlock}</main>`,
    );
  }

  private diffRow(d: CaseDiffLike): string {
    const moves = d.scorerMoves
      .map(
        (m) =>
          `<li><code>${esc(m.name)}</code> ${verdictArrow(m.baselinePass, m.candidatePass)} (${pct(m.baselineScore)}→${pct(m.candidateScore)})</li>`,
      )
      .join('');
    return `<div class="diffcard ${d.classification}">
      <div class="dc-head"><strong>${esc(d.caseId)}</strong>
        ${pill(d.baselinePass ? 'pass' : 'fail', d.baselinePass ? 'ok' : 'bad')}
        →
        ${pill(d.candidatePass ? 'pass' : 'fail', d.candidatePass ? 'ok' : 'bad')}
        <span class="cscore">${delta(d.scoreDelta)}</span>
      </div>
      ${moves ? `<ul class="moves">${moves}</ul>` : ''}
    </div>`;
  }

  private diffTableRow(d: CaseDiffLike): string {
    const moved = d.scorerMoves.map((m) => esc(m.name)).join(', ') || '—';
    return `<tr class="${d.classification}">
      <td><code>${esc(d.caseId)}</code></td>
      <td>${pill(d.baselinePass ? 'P' : 'F', d.baselinePass ? 'ok' : 'bad')} ${pct(d.baselineScore)}</td>
      <td>${pill(d.candidatePass ? 'P' : 'F', d.candidatePass ? 'ok' : 'bad')} ${pct(d.candidateScore)}</td>
      <td class="${d.scoreDelta >= 0 ? 'up' : 'down'}">${delta(d.scoreDelta)}</td>
      <td class="detail">${moved}</td>
    </tr>`;
  }

  // --- Page shell + styles --------------------------------------------------

  private page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head><body>${body}<footer>Generated by agentrie eval layer — traced + measured.</footer></body></html>`;
  }
}

/** Structural type so the report can render both CaseDiff shapes uniformly. */
interface CaseDiffLike {
  caseId: string;
  baselinePass: boolean;
  candidatePass: boolean;
  baselineScore: number;
  candidateScore: number;
  scoreDelta: number;
  classification: string;
  scorerMoves: {
    name: string;
    baselineScore: number;
    candidateScore: number;
    baselinePass: boolean;
    candidatePass: boolean;
  }[];
}

// --- tiny HTML helpers ------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function delta(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}pp`;
}

function pill(text: string, cls: string): string {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

function scorecard(
  label: string,
  value: string,
  good: boolean,
  sub?: string,
): string {
  return `<div class="card ${good ? 'good' : 'warn'}">
    <div class="card-label">${esc(label)}</div>
    <div class="card-value">${esc(value)}</div>
    ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function verdictArrow(from: boolean, to: boolean): string {
  return `${from ? 'pass' : 'fail'} → ${to ? 'pass' : 'fail'}`;
}

const STYLES = `
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--muted:#8b949e;
--ok:#2ea043;--bad:#da3633;--na:#6e7681;--accent:#1f6feb;}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:var(--bg);color:var(--fg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
header{padding:24px 28px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{margin:0 0 8px;font-size:22px}.ver{color:var(--muted);font-weight:400;font-size:14px}
.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);margin-bottom:16px}
.meta code{color:var(--fg)}
.scorecards{display:flex;gap:14px;flex-wrap:wrap}
.card{padding:12px 16px;border-radius:10px;border:1px solid var(--line);min-width:140px;background:var(--bg)}
.card.good{border-color:#1f4d2b}.card.warn{border-color:#5c2a26}
.card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.card-value{font-size:22px;font-weight:600;margin-top:2px}
.card-sub{font-size:12px;color:var(--muted)}
.bigdelta{font-size:16px;font-weight:600;margin:14px 0 0}.bigdelta.ok{color:var(--ok)}.bigdelta.bad{color:var(--bad)}
main{padding:20px 28px;max-width:1100px}
.case{margin:0 0 10px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.case.f{border-color:#5c2a26}
summary{display:flex;gap:12px;align-items:center;cursor:pointer;padding:12px 16px;list-style:none}
summary::-webkit-details-marker{display:none}
.cid{font-weight:600}.status{color:var(--muted);font-size:12px}
.cscore{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--muted)}
.answer{padding:8px 16px;color:var(--fg);border-top:1px solid var(--line)}
.err{color:#ff7b72;padding:4px 16px;margin:0}
.muted{color:var(--muted);padding:8px 16px}
table.scorers{width:calc(100% - 32px);margin:10px 16px;border-collapse:collapse;font-size:13px}
table.scorers th,table.scorers td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.scorers th{color:var(--muted);font-weight:500}
.detail{color:var(--muted)}
.trace{padding:6px 16px 14px}.trace h4{margin:8px 0 6px;color:var(--muted);font-weight:500}
ul.spantree,.spantree ul{list-style:none;margin:0;padding-left:18px;border-left:1px solid var(--line)}
ul.spantree{padding-left:6px;border:none}
.spantree li{padding:3px 0}
.span-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.span-dot.ok{background:var(--ok)}.span-dot.bad{background:var(--bad)}.span-dot.na{background:var(--na)}
.span-name{color:var(--fg)}.span-dur{color:var(--muted);font-size:12px;margin:0 8px}
.attr{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:5px;
padding:0 6px;margin-left:5px;font-size:11px;color:var(--muted);font-family:ui-monospace,monospace}
.pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:600;color:#fff}
.pill.ok{background:var(--ok)}.pill.bad{background:var(--bad)}.pill.na{background:var(--na)}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:0 6px}
.block{margin:0 0 22px}.block h2{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:6px}
.block.reg h2{color:#ff7b72}.block.imp h2{color:#3fb950}
.diffcard{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0;background:var(--panel)}
.diffcard.regression{border-color:#5c2a26}.diffcard.improvement{border-color:#1f4d2b}
.dc-head{display:flex;gap:10px;align-items:center}.dc-head .cscore{margin-left:auto}
ul.moves{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
table.diff{width:100%;border-collapse:collapse;font-size:13px}
table.diff th,table.diff td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
table.diff th{color:var(--muted);font-weight:500}
tr.regression{background:rgba(218,54,51,.08)}tr.improvement{background:rgba(46,160,67,.08)}
.up{color:var(--ok)}.down{color:var(--bad)}
footer{padding:18px 28px;color:var(--muted);border-top:1px solid var(--line);font-size:12px}
`;
