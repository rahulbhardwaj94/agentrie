import { ConsoleLogger, type LoggerService } from '@nestjs/common';
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs';

const LOGGER_NAME = 'agentrie';

/**
 * Nest LoggerService that bridges application logs into the OTel logs pipeline
 * while keeping the familiar console output.
 *
 * Each Nest log call is mirrored as an OTel LogRecord emitted off the GLOBAL
 * LoggerProvider (installed by the SDK in otel.ts). Because `emit` captures the
 * active context, records made inside a span are automatically correlated with
 * that trace/span id — so logs and traces line up in the backend. With no
 * LoggerProvider installed (SDK off / tests), the global logs API is a no-op and
 * only the console output remains.
 *
 * Installed via `app.useLogger(...)` in main.ts when OTEL_LOGS_ENABLED is on.
 */
export class OtelLoggerService extends ConsoleLogger implements LoggerService {
  private get otel(): Logger {
    return logs.getLogger(LOGGER_NAME);
  }

  override log(message: unknown, context?: unknown): void {
    super.log(message as string, context as string);
    this.emit(SeverityNumber.INFO, 'INFO', message, context);
  }

  override error(message: unknown, stack?: unknown, context?: unknown): void {
    super.error(message as string, stack as string, context as string);
    this.emit(SeverityNumber.ERROR, 'ERROR', message, context ?? stack);
  }

  override warn(message: unknown, context?: unknown): void {
    super.warn(message as string, context as string);
    this.emit(SeverityNumber.WARN, 'WARN', message, context);
  }

  override debug(message: unknown, context?: unknown): void {
    super.debug(message as string, context as string);
    this.emit(SeverityNumber.DEBUG, 'DEBUG', message, context);
  }

  override verbose(message: unknown, context?: unknown): void {
    super.verbose(message as string, context as string);
    this.emit(SeverityNumber.TRACE, 'TRACE', message, context);
  }

  private emit(
    severityNumber: SeverityNumber,
    severityText: string,
    message: unknown,
    context?: unknown,
  ): void {
    this.otel.emit({
      severityNumber,
      severityText,
      body: typeof message === 'string' ? message : JSON.stringify(message),
      attributes:
        typeof context === 'string' ? { 'log.context': context } : undefined,
    });
  }
}
