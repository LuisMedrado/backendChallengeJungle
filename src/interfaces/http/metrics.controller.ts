import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { METRICS } from '../../infrastructure/tokens';

// scrape do Prometheus, sem autenticação como os health checks
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
