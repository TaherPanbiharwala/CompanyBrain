// A fixed-window in-memory limiter for /auth/*.
//
// The auth routes are reachable pre-authentication and touch a small connection pool, so an
// unthrottled flood could starve login for everyone. Deliberately no new dependency and no shared
// store: this is a single-instance guard for M2. When there is more than one instance, each gets
// its own bucket — that is a known and acceptable limitation at design-partner scale, not an
// oversight. (Note: behind a proxy without TRUST_PROXY set, req.ip is the PROXY's address and every
// caller shares one bucket — src/boot.ts assertDeploymentSafe() REFUSES TO BOOT on exactly that,
// D44; it used to be only a console.warn, which is not a control.)
export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly opts: RateLimitOptions) {}

  /** Returns true when the caller is over budget. */
  hit(key: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return false;
    }
    b.count += 1;
    return b.count > this.opts.max;
  }

  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    return Math.max(0, Math.ceil((b.resetAt - now) / 1000));
  }

  /** Drop expired buckets so a stream of unique IPs cannot grow the map without bound. Amortized:
   *  at most once per window, on a request that is already doing work. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now >= b.resetAt) this.buckets.delete(k);
  }

  /** Test hook. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep = 0;
  }
}

/** 30 requests / 5 minutes / IP across all of /auth/*. Generous for a human signing in, tight
 *  enough that a junk-cookie or invite-token flood cannot occupy the pool. */
export const authLimiter = new FixedWindowLimiter({ windowMs: 5 * 60_000, max: 30 });

/** 300 requests / minute / IP, app-wide, BEFORE any identity is resolved.
 *
 *  This one exists because of an ordering bug the M1+M2 review found: `apiLimiter` below is keyed on
 *  the PRINCIPAL, which is only known after `resolveSessionContext` has already spent a database
 *  round trip on the `cb_app` pool. So the limiter meant to protect that pool could not fire until
 *  after the pool had been used.
 *
 *  `looksLikeToken` rejects malformed cookies from memory, but ANY random 43-char base64url string
 *  passes it — so a flood of well-formed junk cookies walked straight through to the database. At
 *  Seoul latency and a 10-connection pool that is roughly 80 unauthenticated req/s to saturation,
 *  starving every authenticated `ask` and `ingest`.
 *
 *  Deliberately generous: this is a coarse shed for floods, not a per-user budget. That is what
 *  apiLimiter is, and it still runs afterwards. Cheap throttle first, expensive one second. */
export const preAuthLimiter = new FixedWindowLimiter({ windowMs: 60_000, max: 300 });

/** 120 requests / minute / PRINCIPAL on /api/:op.
 *
 *  Keyed on the principal, not the IP: one office behind NAT is one address, so an IP key would
 *  throttle a whole customer as if they were one user. The principal is only known AFTER the
 *  resolver runs, which is why this cannot live in the same middleware as the /auth limiter.
 *
 *  Sized to be invisible to a human and to an agent doing normal work, while still bounding the
 *  expensive surface: until the M2 review the CHEAP pre-auth routes were throttled and the costly
 *  authenticated ones were not — `ask` runs a hybrid search plus a paid model call, and `ingest`
 *  embeds every chunk. That is the wrong way round. */
export const apiLimiter = new FixedWindowLimiter({ windowMs: 60_000, max: 120 });
