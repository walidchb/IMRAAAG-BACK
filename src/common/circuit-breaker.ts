export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    public readonly name: string,
    private readonly threshold = 5,
    private readonly resetTimeoutMs = 30000,
  ) {}

  get isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new Error(`Circuit breaker open for "${this.name}" (${this.failures} failures)`);
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= this.threshold) {
        this.state = 'open';
      }
      throw err;
    }
  }

  reset(): void {
    this.failures = 0;
    this.lastFailureTime = 0;
    this.state = 'closed';
  }
}

const registry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string): CircuitBreaker {
  let cb = registry.get(name);
  if (!cb) {
    cb = new CircuitBreaker(name);
    registry.set(name, cb);
  }
  return cb;
}

export function resetAllCircuitBreakers(): void {
  registry.clear();
}
