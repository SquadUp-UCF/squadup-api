import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PwnedPasswordService } from './pwned-password.service';

function sha1Upper(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase();
}

/** Minimal ConfigService stub returning a fixed value for any key. */
function makeConfig(value?: string) {
  return { get: jest.fn().mockReturnValue(value) } as never;
}

describe('PwnedPasswordService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    // Keep fail-open warnings out of the test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is a no-op returning false when disabled via config', async () => {
    fetchSpy = jest.spyOn(global, 'fetch');
    const service = new PwnedPasswordService(makeConfig('false'));

    await expect(service.isPwned('anything')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries only the 5-char hash prefix (k-anonymity) and matches the suffix', async () => {
    const password = 'Str0ng#Pass';
    const hash = sha1Upper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `${suffix}:42\nDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEAD:0`,
    } as Response);

    const service = new PwnedPasswordService(makeConfig());
    await expect(service.isPwned(password)).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    // The full hash and its suffix must never leave this service.
    expect(calledUrl).not.toContain(suffix);
  });

  it('returns false when the suffix is not in the range response', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3',
    } as Response);

    const service = new PwnedPasswordService(makeConfig());
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
  });

  it('ignores padding entries that carry a zero count', async () => {
    const suffix = sha1Upper('Str0ng#Pass').slice(5);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `${suffix}:0`,
    } as Response);

    const service = new PwnedPasswordService(makeConfig());
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
  });

  it('fails open (false) on a non-OK response', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 503 } as Response);

    const service = new PwnedPasswordService(makeConfig());
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
  });

  it('fails open (false) when the request throws', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network down'));

    const service = new PwnedPasswordService(makeConfig());
    await expect(service.isPwned('Str0ng#Pass')).resolves.toBe(false);
  });
});
