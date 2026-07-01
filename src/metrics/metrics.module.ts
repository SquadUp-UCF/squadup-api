/**
 * Metrics feature module. Marked `@Global` so any provider (e.g. the breach
 * checker in AuthModule) can inject `MetricsService` without importing this
 * module explicitly.
 */
import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
