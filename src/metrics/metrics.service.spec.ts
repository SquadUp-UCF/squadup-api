import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('renders the pwned-check counter with per-outcome totals', async () => {
    service.recordPwnedPasswordCheck('breached');
    service.recordPwnedPasswordCheck('failed_open');
    service.recordPwnedPasswordCheck('failed_open');

    const output = await service.render();

    expect(output).toContain('squadup_pwned_password_checks_total');
    expect(output).toMatch(
      /squadup_pwned_password_checks_total\{[^}]*outcome="breached"[^}]*\}\s+1/,
    );
    expect(output).toMatch(
      /squadup_pwned_password_checks_total\{[^}]*outcome="failed_open"[^}]*\}\s+2/,
    );
  });

  it('exposes the Prometheus content type', () => {
    expect(service.contentType).toContain('text/plain');
  });
});
