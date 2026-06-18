import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AppConfigService } from '../config/app-config.service';
import { CodeReviewerWorker } from '../workers/code-reviewer.worker';
import {
  SNS_CLIENT,
  SQS_CLIENT,
  createSnsClient,
  createSqsClient,
} from './aws';
import { EVENT_BUS } from './event-bus.interface';
import { SnsPublisher } from './sns.publisher';
import { SqsConsumer } from './sqs.consumer';
import { SummarizationPublisher } from './summarization.publisher';

/**
 * Phase 2 module (scaffold). Provides the AWS SDK v3 clients (LocalStack-pointed),
 * the SNS publisher (EVENT_BUS), the long-polling SQS consumer, and a sample
 * specialized worker. Internal worker bodies are stubbed; the trace-propagation
 * and idempotency wiring is real.
 */
@Module({
  imports: [AgentModule],
  providers: [
    {
      provide: SNS_CLIENT,
      inject: [AppConfigService],
      useFactory: createSnsClient,
    },
    {
      provide: SQS_CLIENT,
      inject: [AppConfigService],
      useFactory: createSqsClient,
    },
    SnsPublisher,
    SqsConsumer,
    CodeReviewerWorker,
    SummarizationPublisher,
    { provide: EVENT_BUS, useExisting: SnsPublisher },
  ],
  exports: [EVENT_BUS, SqsConsumer],
})
export class EventsModule {}
