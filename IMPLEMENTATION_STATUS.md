# Implementation Status — what's real vs. stubbed, and what's next

Reference doc for this build pass. Use it to know exactly what runs today and what
remains. Legend: ✅ real & runnable · 🟡 partial (real seam, stubbed body) · ⛔ TODO.

---

## Phase 0 — Agent Decision Loop ✅ REAL

| Item | Status | Where |
| --- | --- | --- |
| Context-assembly → LLM → tool-exec → repeat loop | ✅ | `src/agent/agent-runner.service.ts` |
| Guardrails: maxIterations / maxToolCalls / wall-clock timeout | ✅ | same |
| Structured terminal result (never throws into the void) | ✅ | `src/agent/agent.types.ts` |
| Per-iteration span + child LLM/tool spans w/ GenAI tags | ✅ | runner + `observability/tracing.service.ts` |
| HTTP entrypoint `POST /agent/run` | ✅ | `src/agent/agent.controller.ts` |

## Phase 1 — State Management ✅ REAL (the deliverable)

| Item | Status | Where |
| --- | --- | --- |
| Redis token-aware sliding window (LIST `ctx:{sessionId}`) | ✅ | `src/memory/redis-memory.store.ts` |
| Token counts via `LlmProvider.countTokens` (no hardcoded tokenizer) | ✅ | store + providers |
| Window bounded by `getContextLimit`; oldest-first eviction; system+summary pinned | ✅ | store |
| Mongo schema: messages[], summaries[], status, indexes, config-driven archived-TTL | ✅ | `src/memory/schemas/session.schema.ts`, `session.repository.ts` |
| Every windowed message also written to Mongo (source of truth) | ✅ | `store.append` → `repo.appendMessage` |
| 80%-threshold trigger via `@nestjs/event-emitter` (debounced — one emit per crossing via a Redis latch) | ✅ | `store.maybeTriggerSummarization` |
| Summarization worker: summarize oldest half → persist → replace with pinned summary | ✅ | `src/memory/summarization.worker.ts` |
| Idempotent / concurrency-safe (Redlock per session) | ✅ | worker + `lock/` |
| Explicit seam to promote summarizer to SQS-driven | ✅ (comment) | store + worker |

## Phase 2 — Event Orchestration ✅ REAL (worker bodies live)

| Item | Status | Where |
| --- | --- | --- |
| SNS publisher; trace context in **message attributes**, not body | ✅ | `src/events/sns.publisher.ts` |
| SQS long-poll loop (20s), graceful drain on shutdown | ✅ | `src/events/sqs.consumer.ts` |
| Redlock idempotency on dedupe id | ✅ | consumer + `lock/` |
| Poison-pill detection (maxReceiveCount → leave for DLQ) | ✅ | consumer + `events/dlq.ts` |
| DLQ + redrive policy provisioned | ✅ | `scripts/localstack-init.sh` |
| Message routing: task → worker, skip own completion events | ✅ | `consumer.handleMessage` + `workers/worker.types.ts` (Zod) |
| Permanent vs transient failure: bad body → DLQ immediately; transient → retry/redrive | ✅ | `PermanentMessageError` + `consumer.deadLetter` |
| Summarization promoted to SQS (`SUMMARIZATION_TRANSPORT=sqs`); in-process stays default | ✅ | `events/summarization.publisher.ts` + `consumer` route → `summarizeSession` |
| **Specialized-worker handler body** (Code Reviewer drives `AgentRunner`, publishes result) | ✅ | `workers/code-reviewer.worker.ts` |
| Visibility heartbeat loop for over-ceiling runs (`ChangeMessageVisibility`) | ✅ | `consumer.withVisibilityHeartbeat` |
| Backoff + jitter on transient-failure retry path (ChangeMessageVisibility) + app-side per-message attempt counter (Redis) with proactive DLQ | ✅ | `events/sqs.consumer.ts` + `events/dlq.ts` |

## Phase 3 — Observability ✅ REAL (all three signals)

| Item | Status | Where |
| --- | --- | --- |
| OTel NodeSDK + OTLP HTTP trace exporter | ✅ | `src/observability/otel.ts` |
| Config-driven sampler: ParentBased(AlwaysOn) default; ratio sampler for prod | ✅ | `otel.ts` `buildSampler` (`OTEL_TRACES_SAMPLER_RATIO`) |
| Tail-based sampling: keep error/slow traces, sample the rest at trace END | ✅ | `src/observability/tail-sampling.ts` (`OTEL_TRACES_TAIL_SAMPLING_ENABLED`) |
| W3C `traceparent` inject/extract across SNS↔SQS | ✅ REAL | `src/observability/propagation.ts` |
| One span/iteration + child LLM/tool spans | ✅ | `agent-runner` + `tracing.service` |
| GenAI attrs (`gen_ai.system/request.model/usage.*/tool.name`) | ✅ | `tracing.service` |
| Metrics pipeline: OTLP metric exporter + periodic reader; GenAI instruments | ✅ | `otel.ts` + `src/observability/metrics.service.ts` (wired into `agent-runner`) |
| Orchestration metrics past the agent loop: SQS handler-outcome counter + retry-backoff histogram; Redlock acquire-outcome (contention) counter | ✅ | `metrics.service.ts` (wired into `events/sqs.consumer.ts` + `lock/redlock.service.ts`) |
| Logs pipeline: OTLP log exporter + trace-correlated Nest logger bridge | ✅ | `otel.ts` + `src/observability/otel-logger.service.ts` (installed in `main.ts`) |
| Flush in-flight spans/metrics/logs on shutdown | ✅ | `main.ts` (`sdk.shutdown`) |

## Phase 4 — Tool Registry ✅ REAL (registry + `read_file` hardened) · OS sandbox ⛔ TODO

| Item | Status | Where |
| --- | --- | --- |
| Zod schema registry; validate-before-exec; structured LLM-readable errors | ✅ | `src/tools/tool-registry.service.ts` |
| Allowlist (unknown tool rejected) | ✅ | registry |
| Tool failures returned into context, never crash the process | ✅ | registry |
| Sample tools: `echo` (safe), `read_file` (workspace-root jail) | ✅ | `src/tools/tools/*` |
| `read_file` hardening: symlink-escape + TOCTOU + non-regular-file defense | ✅ | `src/tools/path-jail.ts` (`openWithinRoot`) + `read-file.tool.ts` |
| Exec jail for shell/fs tools: no-shell spawn, env scrub, cwd jail, timeout, output cap, priv-drop | ✅ | `src/tools/sandbox.ts` (`runSandboxed`) |
| Kernel-level confinement (seccomp syscall filter, mount/pid/net namespaces) + intermediate-component TOCTOU (`openat2`) | ⛔ TODO(deploy) | needs OS isolation, not Node; run under a container/seccomp profile — noted in `sandbox.ts`/`path-jail.ts` |

## Phase 5 — Eval & Scoring Layer ✅ REAL (the differentiator)

Answers the two questions the platform couldn't: *"is this agent good?"* and *"did
my change help?"*. Runs the **unmodified** `AgentRunner` against datasets, scores
the structured result **and the emitted span tree**, and diffs configs. The whole
suite runs end-to-end on the keyless `FakeLlmProvider`.

| Item | Status | Where |
| --- | --- | --- |
| Typed dataset format (`EvalCase`/`Dataset`), Zod-validated on read, id-unique | ✅ | `src/eval/dataset/*`, `evals/datasets/seed.json` |
| Seed dataset — 24 deterministic cases incl. 8 intentional failures (agg ≠ 100%) | ✅ | `evals/datasets/seed.json` |
| `EvalRunnerService` — bounded concurrency, per-case result **+ span tree** | ✅ | `src/eval/eval-runner.service.ts` |
| Span tree captured by reusing the existing trace context (one trace id/case) | ✅ | `src/eval/span-collector.service.ts` |
| Robust to a single case throwing (scores 0, recorded, suite continues) | ✅ | runner `runCase` |
| Persist runs to Mongo `eval_runs` (dataset+version, config fingerprint, scores) | ✅ | `src/eval/store/*` (behind `EVAL_RUN_STORE`) |
| Outcome scorers: exact-match, contains (predicate), numeric-tolerance, status | ✅ | `src/eval/scoring/outcome.scorers.ts` |
| Trace-derived scorers: tool-call-budget, forbidden-tool, iteration/token-budget, no-error-spans | ✅ | `src/eval/scoring/trace.scorers.ts` |
| LLM-as-judge: opt-in behind `LlmProvider`; deterministic fake stub keyless; degrades to `judge-unavailable` | ✅ | `src/eval/scoring/judge.scorer.ts` |
| Composition: weighted-mean aggregate (configurable), pass = all required scorers | ✅ | `src/eval/scoring/scorer-registry.service.ts` |
| `EvalCompareService` — baseline vs candidate diff, **regressions surfaced loudly** | ✅ | `src/eval/eval-compare.service.ts` |
| CLI `eval run` / `eval compare` — console table + JSON artifact + exit-code gating | ✅ | `src/eval/cli.ts` (`npm run eval`) |
| CI gate policy: run floors (`--min-score`/`--min-pass-rate`) + compare budgets (regressions, `--max-aggregate-drop`/`--max-pass-rate-drop`); distinct exit codes | ✅ | `src/eval/gating.ts` (pure, tested) |
| Self-contained HTML report with inline span tree per case | ✅ | `src/eval/report/report.service.ts`, `evals/sample-run-report.html` |
| Config: `EVAL_CONCURRENCY` / `EVAL_JUDGE_ENABLED` / `EVAL_WEIGHTS` / `EVAL_REPORT_DIR`, fail-fast | ✅ | `src/config/env.schema.ts` |
| Tests: seed determinism, over-budget trace scorer, planted regression, forbidden-tool | ✅ | `test/eval.spec.ts` |
| Real per-run tool-set scoping (vary the exposed tools per run/compare side) | ✅ | `ToolScope` seam: `AgentRunInput.tools` + `ToolRegistryService.list/execute/names(scope)`; `AgentConfigOverride.tools` fingerprints the effective set |
| Dataset YAML loader | ⛔ TODO | JSON shipped; YAML is a one-branch extension in `DatasetLoader` |

## Cross-cutting

| Item | Status |
| --- | --- |
| Zod env validation, fail-fast on boot (+ visibility>exec invariant) | ✅ |
| Typed LLM errors: timeout, 429 rate-limit (→ domain errors) | ✅ (`anthropic.provider.ts`) |
| Graceful shutdown: drain SQS consumer + flush OTel | ✅ |
| Provider seams: `LlmProvider`, `MemoryStore`, `LockService`, `EventBus` | ✅ |
| Tests: idempotency, poison-pill→DLQ, summarization trigger (+ eviction, agent loop) | ✅ |
| Tests: eval determinism, trace-scorer over-budget, compare regression, forbidden-tool | ✅ |

---

## Recently shipped

- **Per-run tool-set scoping (eval follow-on).** Compare mode can now vary the
  *exposed tools*, not just prompt/budgets. A `ToolScope` (`allow`/`deny`) threads
  through `AgentRunInput.tools` into a scope-aware `ToolRegistryService`
  (`list`/`names`/`execute` take a scope): the scope narrows the registry allowlist
  and is a real boundary on **both** ends — the model is only advertised in-scope
  tools, and a call to a registered-but-withheld tool is refused with a structured
  `is not available in this run` result (the tool body never runs), distinct from
  the `Unknown tool` allowlist miss. `AgentConfigOverride.tools` flows it through the
  eval runner, and the run **fingerprint records the EFFECTIVE set** (`names(scope)`)
  so a score delta is attributable to the tool change; the CLI carries it in the
  candidate/baseline JSON (`'{"tools":{"deny":["read_file"]}}'`). Tests:
  `test/tool-scope.spec.ts` (allow/deny/combine, execution boundary) and
  `test/agent-runner.spec.ts` (only in-scope tools advertised; denied call doesn't
  run the body).
- **Eval CI gating (eval follow-on).** Pure, tested gate policy (`src/eval/gating.ts`)
  the CLI exits on, so a pipeline branches on the *reason*: **run floors**
  (`--min-score`, `--min-pass-rate`) and **compare budgets** (any regression fails by
  default — `--allow-regressions` to opt out — plus `--max-aggregate-drop` /
  `--max-pass-rate-drop`). Thresholds accept a fraction or a percent. Exit-code
  contract: `0` pass · `1` error · `2` compare-gate · `3` run-gate (so `eval … ||
  handle-by-code` works). Subsumes the old inline regression check. Tests:
  `test/gating.spec.ts` (threshold parsing, run floors, compare budgets, regression
  gating + opt-out).
- **Tail-based trace sampling (was next-step #1).** Head sampling decides at
  root-span *start*, before a trace's fate is known — so a low ratio drops exactly
  the error/slow traces you want. `TailSamplingSpanProcessor`
  (`src/observability/tail-sampling.ts`) defers the decision to trace *end*: it
  buffers a trace's spans, and when the local-root span ends (no parent, or a remote
  `traceparent` — captured at `onStart` so continued SNS→SQS traces still flush)
  applies `tailDecision` — **always keep** a trace that errored or whose root ran
  past `OTEL_TRACES_TAIL_LATENCY_MS`, otherwise sample at `OTEL_TRACES_SAMPLER_RATIO`
  deterministically by trace id (kept whole or not at all). Kept traces forward to a
  wrapped `BatchSpanProcessor`; memory is bounded (oldest-trace eviction past a cap);
  `forceFlush`/`shutdown` drain what's buffered. Opt-in via
  `OTEL_TRACES_TAIL_SAMPLING_ENABLED` (off → the head ratio sampler stays); when on,
  the head sampler is forced to AlwaysOn so the processor sees every span. Single-
  process by design — the OTel Collector's `tail_sampling` processor is the
  cross-replica option and needs no app change. Tests: `test/tail-sampling.spec.ts`
  (error-keep, slow-keep, deterministic ratio, remote-root flush, forceFlush drain).
- **Exec jail for shell/fs tools (was next-step #2).** The *application-layer* half
  of "run tools under a jail" — what's genuinely enforceable in pure Node. `runSandboxed`
  (`src/tools/sandbox.ts`) spawns with **`shell: false`** (args are inert data — no
  `;`/`$()`/glob injection), a **scrubbed env** (a minimal allowlist + caller vars,
  never the parent's `process.env`, so no keys/creds leak), a **cwd jailed** to the
  workspace root (reuses `path-jail`'s `isWithinRoot`), a **wall-clock timeout**
  (SIGKILL), an **output-byte cap** (kills a chatty/adversarial child), and an
  optional **uid/gid drop**. It returns a structured outcome (escape / spawn-failure
  vs. a ran-process result). The residual is now sharply bounded and explicitly
  deploy-time: syscall filtering (seccomp) and fs/pid/net namespaces need a
  container/seccomp profile around the process, and the intermediate-component
  path TOCTOU needs `openat2` (a syscall Node doesn't expose) — the pure-Node
  ceiling, documented in `sandbox.ts`/`path-jail.ts`. Not wired into the registry
  (the agent isn't handed shell access); it's the tested seam a future shell tool
  runs under. Tests: `test/sandbox.spec.ts` (stdout capture, cwd-escape refused, env
  scrub + allowlist, no-shell-injection, timeout→SIGKILL, output cap, spawn failure).
- **Orchestration metrics past the agent loop (was next-step #1).** The metrics
  pipeline now covers the Phase 2 event layer, not just the agent loop. `SqsConsumer`
  records a terminal outcome per message on the `sqs.messages` counter
  (`success`/`duplicate`/`poison_pill`/`permanent_dlq`/`transient_dlq`/`retry`) at
  each disposition branch, plus the applied delay on a `sqs.retry.backoff` histogram
  — so DLQ rates and retry storms are visible as metrics. `RedlockService` reports
  every acquire round on a `lock.acquire` counter, distinguishing `acquired` from
  `contended` (a competitor holds the quorum) and `expired` (quorum met but the
  validity window burned) — the contention/slow-master signal derives from this. Both
  record through `MetricsService`; the lock layer stays decoupled via a small
  `LockMetrics` structural seam (optional ctor arg, so the keyless Redlock test
  constructors are untouched and metrics no-op without an SDK). Tests:
  `test/redlock.service.spec.ts` (acquired/contended/expired) and new assertions in
  `test/sqs-poison-pill.spec.ts` (outcome recorded at every branch + backoff). Only
  tail-based sampling remains from the observability follow-ons.
- **Debounced summarization trigger (was next-step #1).** The 80% threshold used
  to fire on *every* append while the window sat over the line — and because the
  `summarize.session` dedupeId carries `totalTokens` (which moves per append),
  transport-level dedup couldn't collapse the burst. `maybeTriggerSummarization`
  (`src/memory/redis-memory.store.ts`) now gates the emit behind a Redis latch:
  `SET NX` with a cooldown TTL wins only for the first append over the line, so the
  crossing emits exactly one event; the latch is `DEL`'d the moment the window drops
  back under threshold so the next genuine crossing re-fires immediately, and the
  TTL self-heals a session stuck above threshold (slow/failed summarizer) by
  re-firing after the cooldown. Applies in both `inprocess` and `sqs` modes (it's a
  store-level trigger refinement). New config: `SUMMARIZE_COOLDOWN_MS` (default 30s).
  Tests: `test/redis-memory.store.spec.ts` (single emit across an over-threshold
  burst, re-arm after dropping below threshold via summarization, no fire below
  threshold).
- **Observability depth — metrics + logs pipelines + ratio sampler (was
  next-step #1).** Phase 3 goes from 🟡 scaffold to ✅: all three OTLP signals now
  ride the same collector endpoint. `startOtel` (`src/observability/otel.ts`) wires
  a `PeriodicExportingMetricReader` + OTLP metric exporter and a
  `BatchLogRecordProcessor` + OTLP log exporter into the `NodeSDK` alongside the
  existing trace exporter; `sdk.shutdown()` flushes all three on exit. The root
  sampler is config-driven via `buildSampler` (pure/tested): `OTEL_TRACES_SAMPLER_RATIO=1`
  keeps the historical `ParentBased(AlwaysOn)`, `<1` swaps the root to
  `TraceIdRatioBased` for prod cost control while still honoring an upstream
  `traceparent`. A `MetricsService` (`metrics.service.ts`, global-Meter-backed so it
  no-ops safely without an SDK) exposes GenAI-aligned instruments —
  `agent.runs`/`agent.iterations` (by status), `agent.tool_calls` (by tool+outcome),
  `llm.request.duration`, `llm.tokens` (by direction) — recorded from `AgentRunner`
  at the existing span sites. An `OtelLoggerService` bridges Nest logs into the logs
  pipeline with trace correlation (installed via `app.useLogger` in `main.ts` when
  `OTEL_LOGS_ENABLED`), preserving console output. All toggles default on with
  `OTEL_ENABLED` and degrade to no-ops keyless. New config:
  `OTEL_METRICS_ENABLED`, `OTEL_LOGS_ENABLED`, `OTEL_METRIC_EXPORT_INTERVAL_MS`,
  `OTEL_TRACES_SAMPLER_RATIO`. Tests: `test/observability.spec.ts` (sampler
  selection, metrics recorded via in-memory reader, no-op-without-provider, log
  bridge emits a LogRecord). Remaining: tail-based sampling and per-call-site
  instrumentation beyond the agent loop (e.g. SQS handler-outcome counters) are
  trivial follow-ons.
- **Tool sandboxing — `read_file` filesystem hardening (was next-step #1).** The
  documented `TODO(phase-4)` symlink/TOCTOU/non-regular-file gap is closed. A
  shared `openWithinRoot` jail (`src/tools/path-jail.ts`) replaces the old
  trust-the-string-resolve check: it (1) keeps the cheap `..`/absolute pre-check,
  (2) `realpath`s the workspace root, (3) `open`s the candidate to pin an fd to the
  inode at open time, (4) **fstat's the fd** (not the path) to reject directories,
  devices, FIFOs and sockets with no TOCTOU window, and (5) `realpath`s the target
  for containment **and binds it to the fd by (dev, ino)** so a path swapped
  between open and validate is caught — we then read from the fd, not the path.
  Symlinks that resolve outside the root are refused; symlinks to in-root files
  still read. The tool keeps its `Refused:` / `Failed to read:` structured-error
  contract (escape wording unchanged), the `Tool` interface, the registry
  validate-before-exec path, and the allowlist are untouched, and
  `TOOL_WORKSPACE_ROOT` stays the config seam. Tests: `test/read-file.tool.spec.ts`
  (in-root read, `..` + absolute escape, symlink-out, directory/non-regular, plus a
  symlink-to-in-root no-over-rejection case). Still TODO: shell-tool sandboxing and
  the intermediate-directory TOCTOU, both of which need an OS sandbox
  (seccomp/container, Linux `openat2(RESOLVE_BENEATH)`) rather than tool-body code.
- **Backpressure & retries (was next-step #3).** Transient handler failures now
  apply exponential backoff with full jitter via `ChangeMessageVisibilityCommand`
  (`backoffWithJitter` wired into `SqsConsumer.scheduleRetry`), so retries don't all
  land on the fixed visibility window. An app-side, exact per-message attempt
  counter lives in Redis (`sqs:attempts:{dedupeId}`) alongside SQS's approximate
  `ApproximateReceiveCount`: it drives the backoff exponent and, once it crosses
  `SQS_MAX_RECEIVE_COUNT`, the consumer proactively dead-letters instead of waiting
  for the queue's redrive (counter cleared on success/permanent-DLQ, self-expires).
  Config: `SQS_RETRY_BASE_MS` (1000), `SQS_RETRY_CAP_MS` (30000). Tests:
  `test/sqs-poison-pill.spec.ts` (backoff-without-ack, budget-exhausted→DLQ,
  counter cleared on success).
- **Distributed lock (was next-step #1).** `LOCK_SERVICE` now binds to
  `RedlockService` (`src/lock/redlock.service.ts`) — the Redlock algorithm across N
  independent masters: parallel `SET NX PX`, quorum (`⌊N/2⌋+1`), clock-drift/TTL
  validity check, fenced compare-and-delete release on every master, and rollback
  of partial holds on a missed quorum. Backward compatible: with a single
  `REDIS_URL` (no `REDIS_NODES`) quorum is 1 and it matches the old single-node
  behavior. Config: `REDIS_NODES` (comma-separated masters) and `LOCK_DRIFT_FACTOR`
  (default `0.01`); `LockModule` owns the per-master connections and quits them on
  shutdown. The `LockService` interface and `LOCK_SERVICE` token are unchanged, so
  `SqsConsumer` and `SummarizationWorker` call sites did not change. Tests:
  `test/redlock.service.spec.ts` (single-node degrade + multi-master quorum,
  contention, rollback, validity).

## What to build next (priority order)

The application-layer work across Phases 0–4 is complete. What remains is **deploy-
time hardening** (not codeable in TypeScript) and the **Phase 5 eval-layer follow-
ons** below.

1. **Kernel-level tool confinement (deploy-time).** The in-process exec jail
   (`sandbox.ts`) and the `read_file` filesystem jail are done; the residual is OS,
   not Node — run workers under a container/seccomp profile (syscall filter + mount/
   pid/net namespaces), which also closes the intermediate-component path TOCTOU that
   needs `openat2(RESOLVE_BENEATH)`. This is infra/IaC, not source.

### Eval layer — what's next

CI gating and per-run tool scoping both shipped (see "Recently shipped"). What's
left: **judge cost control** via ratio/tail sampling (only judge a sampled fraction,
or only the tail of low-scoring cases, instead of every rubric case — reuses the
trace tail-sampling idea); **dataset versioning/diffing** (the run record already
pins `datasetVersion` — surface case-level adds/removes/edits across versions so a
score delta can be attributed to the dataset vs. the agent); and the **dataset YAML
loader** (JSON ships; YAML is a one-branch extension in `DatasetLoader`).
```
