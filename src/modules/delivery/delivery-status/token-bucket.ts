/**
 * A token bucket — the per-tenant provider-call budget (roadmap §12.5).
 *
 * The cadence is the primary throttle; this bucket is the safety net that stops a single cycle
 * from spending a tenant's whole quota when it has a backlog to drain. One bucket per tenant,
 * refilled continuously over a one-minute window.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number = 60_000,
  ) {
    this.tokens = Math.max(0, capacity);
    this.lastRefillAt = Date.now();
  }

  /** Takes one token. Returns `false` when the budget is exhausted. */
  tryConsume(now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** The tokens currently available — for logs and the health payload. */
  remaining(now: number = Date.now()): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;

    const refill = (elapsed / this.windowMs) * this.capacity;
    if (refill <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.lastRefillAt = now;
  }
}
