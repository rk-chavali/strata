/**
 * Backoff on the authentication routes, and nowhere else.
 *
 * strata ships local password accounts with no second factor. On a trusted network that is a
 * reasonable trade. On a public address it means an unlimited-rate guessing machine pointed at
 * `POST /api/auth/login`, and the only thing between an attacker and an editor account is how
 * fast they can send requests.
 *
 * **Two counters, not one.** Per address stops one host grinding through a password list. Per
 * account stops a botnet spreading the same attack across thousands of addresses, which is what
 * credential stuffing actually looks like. Either counter can lock the attempt.
 *
 * **Deliberately not a general rate limiter.** The rest of the API does not need one: a signed-in
 * editor hammering `/api/objects` is a performance question, and answering it with a 429 would
 * break the canvas, which saves on every drag. This module is about guessing credentials.
 *
 * **In memory, and that is correct here.** The supported deployment is one replica, stated as a
 * correctness constraint in the Helm chart because the git working tree is shared mutable state.
 * One process means one counter, so a shared store would add a dependency and buy nothing. If
 * strata ever runs more than one replica, this is one of the things that has to move.
 */

export interface ThrottleOptions {
  /** Failures before the first delay. Below this, an honest typo costs nothing. */
  threshold?: number;
  /** Delay after the first failure past the threshold. Doubles each time. */
  baseDelayMs?: number;
  /** Ceiling on the delay, so a locked account recovers rather than staying locked forever. */
  maxDelayMs?: number;
  /** Forget a key that has been quiet for this long. */
  windowMs?: number;
}

interface Entry {
  failures: number;
  /** Epoch milliseconds before which the next attempt is refused. */
  blockedUntil: number;
  lastSeen: number;
}

export interface ThrottleVerdict {
  allowed: boolean;
  /** Whole seconds the caller should wait. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly windowMs: number;

  constructor(options: ThrottleOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.windowMs = options.windowMs ?? 15 * 60_000;
  }

  /**
   * Whether this attempt may proceed.
   *
   * Checks every key and reports the longest wait, so a caller blocked on both address and
   * account is told the real answer rather than the first one that happened to match.
   */
  check(keys: string[], now = Date.now()): ThrottleVerdict {
    let retryAfterMs = 0;

    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;

      if (now - entry.lastSeen > this.windowMs) {
        this.entries.delete(key);
        continue;
      }

      if (entry.blockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - now);
      }
    }

    if (retryAfterMs === 0) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  /** Record a failed attempt against every key and extend the backoff. */
  fail(keys: string[], now = Date.now()): void {
    for (const key of keys) {
      const existing = this.entries.get(key);
      const stale = existing && now - existing.lastSeen > this.windowMs;
      const failures = (stale || !existing ? 0 : existing.failures) + 1;

      /*
        The delay doubles per failure past the threshold, capped.

        Uncapped doubling reaches days, which turns a denial of service into the easier attack:
        anyone who knows a colleague's username could lock them out indefinitely by failing on
        purpose. The cap keeps guessing impractical while keeping recovery bounded.
      */
      const over = failures - this.threshold;
      const blockedUntil =
        over <= 0
          ? 0
          : now + Math.min(this.baseDelayMs * 2 ** (over - 1), this.maxDelayMs);

      this.entries.set(key, { failures, blockedUntil, lastSeen: now });
    }
  }

  /** Clear the counters for these keys. Called on a successful sign-in. */
  succeed(keys: string[]): void {
    for (const key of keys) this.entries.delete(key);
  }

  /** Drop entries nobody has touched inside the window. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeen > this.windowMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of tracked keys. For tests and the health detail route. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * The address to count against.
 *
 * `X-Forwarded-For` is trusted only when the operator says the deployment is behind a proxy,
 * because a client can send that header itself. Trusting it unconditionally would let an attacker
 * pick a fresh key on every request and defeat the whole module; ignoring it unconditionally would
 * bucket an entire ingress behind one counter and lock out a whole company on one bad actor.
 */
export function clientKey(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${socketAddress ?? "unknown"}`;
}
