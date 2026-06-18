import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentModule } from '../agent/agent.module';
import { DatasetLoader } from './dataset/dataset-loader.service';
import { EvalCompareService } from './eval-compare.service';
import { EvalRunnerService } from './eval-runner.service';
import { ReportService } from './report/report.service';
import { JudgeScorer } from './scoring/judge.scorer';
import {
  ContainsScorer,
  ExactMatchScorer,
  NumericToleranceScorer,
  StatusScorer,
} from './scoring/outcome.scorers';
import { SCORER, type Scorer } from './scoring/scorer.interface';
import { ScorerRegistry } from './scoring/scorer-registry.service';
import {
  ForbiddenToolScorer,
  IterationBudgetScorer,
  NoErrorSpansScorer,
  TokenBudgetScorer,
  ToolCallBudgetScorer,
} from './scoring/trace.scorers';
import { SpanCollector } from './span-collector.service';
import { EVAL_RUN_STORE } from './store/eval-run-store.interface';
import { MongoEvalRunStore } from './store/mongo-eval-run.store';
import { EvalRun, EvalRunSchema } from './store/schemas/eval-run.schema';

/**
 * Eval & scoring layer. Drives the (unmodified) AgentRunner from AgentModule.
 *
 * Scorers register via the `SCORER` multi-provider token — add a scorer by listing
 * it in `scorerProviders` and the `inject` array (mirrors how tools register into
 * the ToolRegistry). The store is bound behind `EVAL_RUN_STORE` so tests can swap
 * an in-memory implementation, exactly like `MEMORY_STORE`/`LOCK_SERVICE`.
 */
const scorerProviders = [
  ExactMatchScorer,
  ContainsScorer,
  NumericToleranceScorer,
  StatusScorer,
  ToolCallBudgetScorer,
  ForbiddenToolScorer,
  IterationBudgetScorer,
  TokenBudgetScorer,
  NoErrorSpansScorer,
  JudgeScorer,
];

@Module({
  imports: [
    AgentModule,
    MongooseModule.forFeature([
      { name: EvalRun.name, schema: EvalRunSchema },
    ]),
  ],
  providers: [
    DatasetLoader,
    SpanCollector,
    ScorerRegistry,
    EvalRunnerService,
    EvalCompareService,
    ReportService,
    MongoEvalRunStore,
    { provide: EVAL_RUN_STORE, useExisting: MongoEvalRunStore },
    ...scorerProviders,
    {
      provide: SCORER,
      useFactory: (...scorers: Scorer[]) => scorers,
      inject: scorerProviders,
    },
  ],
  exports: [
    DatasetLoader,
    EvalRunnerService,
    EvalCompareService,
    ReportService,
    ScorerRegistry,
    SpanCollector,
  ],
})
export class EvalModule {}
