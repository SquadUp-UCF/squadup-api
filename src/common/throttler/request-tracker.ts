/**
 * Rate-limit bucketing key: the authenticated account when there is one, the
 * client IP otherwise.
 *
 * The default tracker buckets on IP alone, which collapses everyone behind a
 * shared egress into a single budget — a campus NAT, a phone carrier, an
 * office. Both clients poll (the app refreshes notifications and pending
 * ratings every 30s), so on UCF wifi a couple of dozen signed-in students
 * would exhaust the per-minute allowance for everybody on that address, and
 * the only way out would be raising the limit until it no longer protects
 * anything. Keying on the account instead gives each user their own budget, so
 * the limit can stay tight.
 *
 * The token is signature-verified, not merely decoded. A decode-only tracker
 * would let anyone mint a token carrying an arbitrary `sub` and get a fresh
 * bucket per request, which removes the limit altogether — the very thing
 * being protected. Verification is an HMAC check against JWT_SECRET with no
 * database round-trip, so it stays cheap enough to run on every request.
 *
 * Anything that is not a valid token — absent, malformed, forged, expired —
 * falls back to the IP bucket. Unauthenticated routes are therefore unchanged,
 * which matters most for the tighter per-IP limit on `/auth`: brute-forcing a
 * login is exactly the case where IP is the right key, and an attacker cannot
 * escape it by attaching a token they cannot sign.
 *
 * `req.ip` is only as trustworthy as Express's `trust proxy` setting — see
 * TRUST_PROXY in main.ts. Behind a proxy without it, every anonymous request
 * shares the proxy's address.
 */
import { JwtService } from '@nestjs/jwt';

/** Namespaced so an account id can never collide with an IP string. */
const USER_PREFIX = 'user:';
const IP_PREFIX = 'ip:';

function bearerToken(req: Record<string, any>): string | null {
  const header: unknown = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Build the tracker function. `secret` is read once at module init rather than
 * per request; a JwtService is created here so the guard needs no injection.
 */
export function createRequestTracker(secret: string | undefined) {
  const jwt = new JwtService({ secret });

  return (req: Record<string, any>): string => {
    const ipKey = `${IP_PREFIX}${req.ip ?? 'unknown'}`;
    if (!secret) return ipKey;

    const token = bearerToken(req);
    if (!token) return ipKey;

    try {
      const payload = jwt.verify<{ sub?: unknown }>(token);
      return typeof payload?.sub === 'string' && payload.sub
        ? `${USER_PREFIX}${payload.sub}`
        : ipKey;
    } catch {
      // Forged, expired, or signed with a different secret — not an identity.
      return ipKey;
    }
  };
}
