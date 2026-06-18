import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { injectTraceContext } from '../observability/propagation';
import { SNS_CLIENT } from './aws';
import type { BusEvent, EventBus } from './event-bus.interface';

/**
 * SNS publisher for agent-completion events (Phase 2 scaffold).
 *
 * REAL wiring: trace context is injected into SNS **MessageAttributes** as the
 * W3C `traceparent` (via observability/propagation), so SQS consumers can rebuild
 * the distributed trace. The body carries ONLY the domain payload — never trace
 * context. This propagation path is real even though downstream worker bodies are
 * stubbed (Phase 2).
 */
@Injectable()
export class SnsPublisher implements EventBus {
  private readonly logger = new Logger(SnsPublisher.name);

  constructor(
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
    private readonly config: AppConfigService,
  ) {}

  async publish(event: BusEvent): Promise<void> {
    // Trace context -> message attributes (REAL).
    const traceAttrs = injectTraceContext();
    const messageAttributes = Object.fromEntries(
      Object.entries(traceAttrs).map(([k, v]) => [
        k,
        { DataType: v.DataType, StringValue: v.StringValue },
      ]),
    );
    // Carry the dedupe id as an attribute too (consumer uses it for idempotency).
    messageAttributes['dedupeId'] = {
      DataType: 'String',
      StringValue: event.dedupeId,
    };

    await this.sns.send(
      new PublishCommand({
        TopicArn: this.config.snsTopicArn,
        Message: JSON.stringify(event), // domain payload only
        MessageAttributes: messageAttributes,
      }),
    );

    this.logger.log(
      `Published ${event.type} for session ${event.sessionId} (dedupe ${event.dedupeId})`,
    );
  }
}
