import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PwnedPasswordService } from './pwned-password.service';
import { MetricsService } from '../metrics/metrics.service';

function sha1Upper(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase();
}

/** Minimal ConfigService stub returning a fixed value for any key. */
function makeConfig(value?: string) {
  return { get: jest.fn().mockReturnValue(value) } as never;
}

describe('PwnedPasswordService', () => {
  let fetchSpy: jest.SpyInstance;
  let metrics: { recordPwnedPasswordCheck: jest.Mock };

  const build = (configValue?: string) =>
    new PwnedPasswordService(
      makeConfig(configValue),
      metrics as unknown as MetricsService,
    );

  beforeEach(() => {
    metrics = { recordPwnedPasswordCheck: jest.fn() };
    // Keep fail-open warnings out of the test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is a no-op that records "disabled" when turned off via config', async () => {
    fetchSpy = jest.spyOn(global, 'fetch');
    const service = build('false');

    await expect(service.isPwned('anything')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('disabled');
  });

  it('queries only the 5-char prefix (k-anonymity), matches the suffix, records "breached"', async () => {
    const password = 'Str0ng#Pass';
    const hash = sha1Upper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `${suffix}:42\nDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEAD:0`,
    } as Response);

    const service = build();
    await expect(service.isPwned(password)).resolves.toBe(true);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(calledUrl).not.toContain(suffix);
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('breached');
  });

  it('records "clean" when the suffix is not in the range response', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3',
    } as Response);

    const service = build();
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('clean');
  });

  it('ignores padding entries (count 0) and records "clean"', async () => {
    const suffix = sha1Upper('Str0ng#Pass').slice(5);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `${suffix}:0`,
    } as Response);

    const service = build();
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('clean');
  });

  it('fails open and records "failed_open" on a non-OK response', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 503 } as Response);

    const service = build();
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('failed_open');
  });

  it('fails open and records "failed_open" when the request throws', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network down'));

    const service = build();
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
    expect(metrics.recordPwnedPasswordCheck).toHaveBeenCalledWith('failed_open');
  });
});
