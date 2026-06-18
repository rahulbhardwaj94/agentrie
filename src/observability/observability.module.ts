import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { TracingService } from './tracing.service';

/**
 * Exposes TracingService + MetricsService app-wide. The OTel SDK itself is started
 * in main.ts (before Nest bootstrap) so propagators/exporters are installed before
 * any span/metric is created; this module only provides the injectable helpers.
 */
@Global()
@Module({
  providers: [TracingService, MetricsService],
  exports: [TracingService, MetricsService],
})
export class ObservabilityModule {}
