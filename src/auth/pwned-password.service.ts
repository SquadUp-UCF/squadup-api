/**
 * Checks a candidate password against Have I Been Pwned's Pwned Passwords
 * corpus using the **range (k-anonymity) API**, so the password never leaves
 * this server:
 *
 *   1. SHA-1 the password locally.
 *   2. Send only the first 5 hex chars of the hash to the range endpoint.
 *   3. The API returns every hash suffix (with breach counts) sharing that
 *      prefix; we match the remaining 35 chars locally.
 *
 * `Add-Padding: true` asks the API to pad the response with decoy (count 0)
 * entries, hiding how many real matches the prefix has — so we only count
 * entries with a positive breach count.
 *
 * The check **fails open**: if the API is unreachable or errors, registration is
 * allowed rather than blocked on a third-party outage. Set
 * `PWNED_PASSWORD_CHECK=false` to disable it entirely (useful offline/in tests).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MetricsService } from '../metrics/metrics.service';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range';

@Injectable()
export class PwnedPasswordService {
  private readonly logger = new Logger(PwnedPasswordService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    // Enabled by default; only `false` disables it.
    this.enabled = this.config.get<string>('PWNED_PASSWORD_CHECK') !== 'false';
  }

  /** True if the password appears in a known breach corpus. */
  async isPwned(password: string): Promise<boolean> {
    if (!this.enabled) {
      this.metrics.recordPwnedPasswordCheck('disabled');
      return false;
    }

    const sha1 = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const response = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
        headers: {
          'Add-Padding': 'true',
          'User-Agent': 'SquadUp-API',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Pwned Passwords API returned ${response.status}; allowing password (fail-open).`,
        );
        this.metrics.recordPwnedPasswordCheck('failed_open');
        return false;
      }

      const body = await response.text();
      const breached = body.split('\n').some((line) => {
        const [hashSuffix, count] = line.trim().split(':');
        // Ignore padding entries, which carry a count of 0.
        return hashSuffix === suffix && Number(count) > 0;
      });

      this.metrics.recordPwnedPasswordCheck(breached ? 'breached' : 'clean');
      return breached;
    } catch (error) {
      this.logger.warn(
        `Pwned Passwords API unreachable; allowing password (fail-open): ${String(error)}`,
      );
      this.metrics.recordPwnedPasswordCheck('failed_open');
      return false;
    }
  }
}
