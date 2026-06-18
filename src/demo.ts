import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentRunner } from './agent/agent-runner.service';
import { AppConfigService } from './config/app-config.service';
import { RedisMemoryStore } from './memory/redis-memory.store';
import { SummarizationWorker } from './memory/summarization.worker';

/**
 * End-to-end demo of Phase 0 + Phase 1, runnable with no AWS and no API key
 * (FakeLlmProvider). It drives several agent turns until the token-aware window
 * crosses 80% of the (small, env-overridable) context limit, then shows the
 * window after summarization.
 *
 *   LLM_CONTEXT_LIMIT=2000 npm run demo
 *
 * Requires Redis + Mongo (docker compose up -d).
 */
async function main(): Promise<void> {
  const logger = new Logger('Demo');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const config = app.get(AppConfigService);
  const runner = app.get(AgentRunner);
  const store = app.get(RedisMemoryStore);
  const summarizer = app.get(SummarizationWorker);

  const sessionId = `demo-${Date.now()}`;
  logger.log(
    `Context limit=${config.llmContextLimit} tokens; summarize at 80% ` +
      `(=${Math.floor(config.llmContextLimit * 0.8)}). Tip: LLM_CONTEXT_LIMIT=2000 for a quick demo.`,
  );

  const prompts = [
    'Tell me about distributed systems and event-driven architecture.',
    'Now explain the role of message queues like SQS and SNS.',
    'How does Redis help as a hot cache in front of MongoDB?',
    'What is OpenTelemetry and how does trace context propagate across services?',
    'Summarize how an agent decision loop ties memory, tools, and an LLM together.',
    'Give me one more paragraph on token-aware sliding windows.',
  ];

  let turn = 0;
  for (const prompt of prompts) {
    turn += 1;
    const result = await runner.run({
      sessionId,
      prompt,
      system: turn === 1 ? 'You are a helpful systems-engineering tutor.' : undefined,
    });
    const tokens = await store.getTokenCount(sessionId);
    logger.log(
      `Turn ${turn}: status=${result.status} iterations=${result.iterations} ` +
        `windowTokens=${tokens}`,
    );
  }

  // Give any async summarization a beat, then force one so the demo is deterministic.
  await summarizer.summarizeSession(sessionId);

  const ctx = await store.getActiveContext(sessionId);
  logger.log(
    `Final window: ${ctx.messages.length} messages, ${ctx.totalTokens} tokens`,
  );
  const summary = ctx.messages.find((m) => m.isSummary);
  if (summary) {
    logger.log(`Pinned summary present (${summary.tokenCount} tokens).`);
  } else {
    logger.log('No summary pinned (threshold not crossed for this run).');
  }

  await app.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
