/**
 * The tracker decides which bucket a request is counted against, so its
 * failure mode is a bypass: anything it accepts as an identity without proof
 * becomes a free bucket, and the limit stops existing. These cover that a
 * token has to be genuinely signed to earn its own bucket, and that every
 * other case lands back on the IP.
 */
import { JwtService } from '@nestjs/jwt';
import { createRequestTracker } from './request-tracker';

const SECRET = 'tracker-test-secret';

function reqWith(authorization?: string, ip = '10.0.0.1'): Record<string, any> {
  return { ip, headers: authorization ? { authorization } : {} };
}

describe('createRequestTracker', () => {
  const jwt = new JwtService({ secret: SECRET });
  const track = createRequestTracker(SECRET);

  it('buckets a validly signed token by its account id', () => {
    const token = jwt.sign({ sub: 'user-123' });
    expect(track(reqWith(`Bearer ${token}`))).toBe('user:user-123');
  });

  it('gives two accounts on one IP separate buckets', () => {
    const a = jwt.sign({ sub: 'alice' });
    const b = jwt.sign({ sub: 'bob' });
    // Same address — a shared campus NAT — must not mean a shared budget.
    expect(track(reqWith(`Bearer ${a}`, '10.0.0.9'))).not.toBe(
      track(reqWith(`Bearer ${b}`, '10.0.0.9')),
    );
  });

  it('falls back to the IP when there is no token', () => {
    expect(track(reqWith(undefined, '203.0.113.7'))).toBe('ip:203.0.113.7');
  });

  it('refuses a token signed with a different secret', () => {
    // The bypass this guards: mint your own `sub`, get your own bucket.
    const forged = new JwtService({ secret: 'not-the-secret' }).sign({
      sub: 'attacker',
    });
    expect(track(reqWith(`Bearer ${forged}`))).toBe('ip:10.0.0.1');
  });

  it('gives forged tokens no way to spread across buckets', () => {
    const other = new JwtService({ secret: 'not-the-secret' });
    const keys = ['a', 'b', 'c'].map((sub) =>
      track(reqWith(`Bearer ${other.sign({ sub })}`, '10.0.0.4')),
    );
    // All three collapse onto the one IP bucket rather than minting three.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('ip:10.0.0.4');
  });

  it('refuses an expired token', () => {
    const expired = jwt.sign({ sub: 'user-123' }, { expiresIn: '-1s' });
    expect(track(reqWith(`Bearer ${expired}`))).toBe('ip:10.0.0.1');
  });

  it('refuses a malformed token or a non-bearer scheme', () => {
    expect(track(reqWith('Bearer not-a-jwt'))).toBe('ip:10.0.0.1');
    expect(track(reqWith('Basic dXNlcjpwYXNz'))).toBe('ip:10.0.0.1');
    expect(track(reqWith('Bearer'))).toBe('ip:10.0.0.1');
  });

  it('ignores a token whose payload carries no usable sub', () => {
    expect(track(reqWith(`Bearer ${jwt.sign({ notASub: 1 })}`))).toBe('ip:10.0.0.1');
  });

  it('buckets everything by IP when no secret is configured', () => {
    const noSecret = createRequestTracker(undefined);
    expect(noSecret(reqWith(`Bearer ${jwt.sign({ sub: 'user-123' })}`))).toBe(
      'ip:10.0.0.1',
    );
  });
});
