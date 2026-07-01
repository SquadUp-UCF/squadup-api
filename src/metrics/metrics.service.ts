/**
 * Application metrics, exposed in Prometheus format at `GET /api/metrics`.
 *
 * Holds its own prom-client `Registry` (rather than the global default) so the
 * service can be instantiated repeatedly — e.g. across tests — without
 * "metric already registered" collisions.
 *
 * The first metric here instruments the Have I Been Pwned breach check, whose
 * fail-open design means an outage silently lets passwords through. The
 * `failed_open` outcome makes that visible so operators can alert when the
 * check stops actually protecting registration.
 */
import { Injectable } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

/**
 * - `clean`       — checked, password not in the breach corpus
 * - `breached`    — checked, password found (registration rejected)
 * - `failed_open` — HIBP unreachable/errored, password allowed through
 * - `disabled`    — the check is turned off via PWNED_PASSWORD_CHECK
 */
export type PwnedCheckOutcome = 'clean' | 'breached' | 'failed_open' | 'disabled';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly pwnedPasswordChecks = new Counter({
    name: 'squadup_pwned_password_checks_total',
    help: 'Have I Been Pwned password checks, labelled by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  constructor() {
    this.registry.setDefaultLabels({ app: 'squadup-api' });
  }

  /** Record the result of one breach check. */
  recordPwnedPasswordCheck(outcome: PwnedCheckOutcome): void {
    this.pwnedPasswordChecks.inc({ outcome });
  }

  /** Serialize all metrics in Prometheus exposition format. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content type for the exposition response. */
  get contentType(): string {
    return this.registry.contentType;
  }
}
