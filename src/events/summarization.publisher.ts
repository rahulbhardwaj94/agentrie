import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppConfigService } from '../config/app-config.service';
import {
  CONTEXT_THRESHOLD_EVENT,
  type ContextThresholdEvent,
} from '../memory/memory-store.interface';
import { EVENT_BUS, type EventBus } from './event-bus.interface';

/**
 * Bridges the in-process `context.threshold` event onto SQS when
 * SUMMARIZATION_TRANSPORT=sqs (Phase 2 promotion of Phase 1's summarizer).
 *
 * The memory store always emits the threshold event in-process; this listener
 * forwards it to the bus *only* in `sqs` mode (in `inprocess` mode the
 * SummarizationWorker handles the same event directly, and this no-ops). That
 * keeps the store decoupled from the transport and avoids a module cycle.
 */
@Injectable()
export class SummarizationPublisher {
  private readonly logger = new Logger(SummarizationPublisher.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly config: AppConfigService,
  ) {}

  @OnEvent(CONTEXT_THRESHOLD_EVENT, { async: true, promisify: true })
  async handleThreshold(event: ContextThresholdEvent): Promise<void> {
    if (!this.config.isSummarizationSqs) {
      // In-process mode: SummarizationWorker.handleThreshold owns this event.
      return;
    }
    await this.events.publish({
      type: 'summarize.session',
      sessionId: event.sessionId,
      // Stable per threshold-crossing (same tokens), distinct across crossings;
      // redeliveries of one publish share it, so transport-level dupes collapse.
      dedupeId: `summarize:${event.sessionId}:${event.totalTokens}`,
      totalTokens: event.totalTokens,
      contextLimit: event.contextLimit,
    });
    this.logger.log(`Queued summarization for ${event.sessionId} via SQS`);
  }
}
