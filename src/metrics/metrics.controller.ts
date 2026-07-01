/**
 * Prometheus scrape endpoint: `GET /api/metrics`.
 *
 * Public and unauthenticated (the usual contract for a metrics endpoint scraped
 * from a private network) and excluded from rate limiting so frequent scrapes
 * are never throttled. If the API is exposed publicly, restrict this at the
 * network/proxy layer.
 */
import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @SkipThrottle()
  @ApiOperation({ summary: 'Prometheus metrics exposition' })
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metricsService.contentType);
    res.send(await this.metricsService.render());
  }
}
