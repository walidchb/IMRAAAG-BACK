import { CircuitBreaker, getCircuitBreaker, resetAllCircuitBreakers } from './circuit-breaker';

beforeEach(() => {
  resetAllCircuitBreakers();
});

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.isOpen).toBe(false);
  });

  it('calls the function and returns its result when closed', async () => {
    const cb = new CircuitBreaker('test');
    const fn = jest.fn().mockResolvedValue('success');

    const result = await cb.call(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('opens after threshold failures', async () => {
    const cb = new CircuitBreaker('test', 3, 60000);
    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(false);

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(false);

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(true);
  });

  it('rejects immediately when open', async () => {
    const cb = new CircuitBreaker('test', 1, 60000);
    const failFn = jest.fn().mockRejectedValue(new Error('fail'));
    const successFn = jest.fn().mockResolvedValue('ok');

    await expect(cb.call(failFn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(true);

    await expect(cb.call(successFn)).rejects.toThrow('Circuit breaker open');
    expect(successFn).not.toHaveBeenCalled();
  });

  it('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker('test', 1, 100);
    const failFn = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(failFn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(true);

    await new Promise((r) => setTimeout(r, 150));

    expect(cb.isOpen).toBe(false);
  });

  it('closes again after half-open call succeeds', async () => {
    const cb = new CircuitBreaker('test', 1, 100);
    const failFn = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(failFn)).rejects.toThrow('fail');

    await new Promise((r) => setTimeout(r, 150));

    const successFn = jest.fn().mockResolvedValue('recovered');
    const result = await cb.call(successFn);
    expect(result).toBe('recovered');
    expect(cb.isOpen).toBe(false);
  });

  it('stays open after half-open call fails', async () => {
    const cb = new CircuitBreaker('test', 1, 100);
    const failFn = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(failFn)).rejects.toThrow('fail');

    await new Promise((r) => setTimeout(r, 150));

    await expect(cb.call(failFn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(true);
  });

  it('resets to closed state', async () => {
    const cb = new CircuitBreaker('test', 1, 60000);
    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.call(fn)).rejects.toThrow('fail');
    expect(cb.isOpen).toBe(true);

    cb.reset();
    expect(cb.isOpen).toBe(false);
  });
});

describe('getCircuitBreaker', () => {
  it('returns the same instance for the same name', () => {
    const a = getCircuitBreaker('shared');
    const b = getCircuitBreaker('shared');
    expect(a).toBe(b);
  });

  it('returns different instances for different names', () => {
    const a = getCircuitBreaker('svc-a');
    const b = getCircuitBreaker('svc-b');
    expect(a).not.toBe(b);
  });
});

describe('resetAllCircuitBreakers', () => {
  it('clears all circuit breakers', () => {
    const a = getCircuitBreaker('x');
    const b = getCircuitBreaker('y');
    resetAllCircuitBreakers();
    const a2 = getCircuitBreaker('x');
    expect(a2).not.toBe(a);
  });
});
