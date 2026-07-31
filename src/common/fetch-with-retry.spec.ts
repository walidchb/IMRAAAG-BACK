import { fetchWithRetry } from './fetch-with-retry';
import { resetAllCircuitBreakers, getCircuitBreaker } from './circuit-breaker';

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  resetAllCircuitBreakers();
});

describe('fetchWithRetry', () => {
  it('returns response on first successful attempt', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetch.mockResolvedValue(okResponse);

    const result = await fetchWithRetry('https://example.com/api');
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable status (500) and succeeds', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetch
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValue(okResponse);

    const result = await fetchWithRetry('https://example.com/api', {}, { maxRetries: 3 });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns non-retryable status (400) without retrying', async () => {
    mockFetch.mockResolvedValue(new Response('bad request', { status: 400 }));

    const result = await fetchWithRetry('https://example.com/api');
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns non-ok response after exhausting retries', async () => {
    mockFetch.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await fetchWithRetry('https://example.com/api', {}, { maxRetries: 3 });
    expect(result.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after all retries fail on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(
      fetchWithRetry('https://example.com/api', {}, { maxRetries: 2 }),
    ).rejects.toThrow('Network error');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it(
    'throws timeout error when request exceeds timeout',
    async () => {
      mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            if ((opts.signal as AbortSignal).aborted) {
              onAbort();
            } else {
              (opts.signal as AbortSignal).addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      });

      await expect(
        fetchWithRetry('https://example.com/api', { timeout: 50 }, { maxRetries: 1 }),
      ).rejects.toThrow('timed out');
    },
    10000,
  );

  it('calls onRetry callback on each retry', async () => {
    const onRetry = jest.fn();
    mockFetch
      .mockResolvedValueOnce(new Response('error', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await fetchWithRetry('https://example.com/api', {}, { maxRetries: 3, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 (rate limited)', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('too many requests', { status: 429 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const result = await fetchWithRetry('https://example.com/api', {}, { maxRetries: 3 });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 408 (request timeout)', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('timeout', { status: 408 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const result = await fetchWithRetry('https://example.com/api', {}, { maxRetries: 3 });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses circuit breaker when circuitBreakerName is provided', async () => {
    const cb = getCircuitBreaker('breaker-test');
    jest.spyOn(cb, 'call');

    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(
      fetchWithRetry('https://example.com/api', {}, { maxRetries: 5, baseDelayMs: 1, circuitBreakerName: 'breaker-test' }),
    ).rejects.toThrow('Network error');

    expect(cb.call).toHaveBeenCalled();

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    await expect(
      fetchWithRetry('https://example.com/api', {}, { maxRetries: 1, baseDelayMs: 1, circuitBreakerName: 'breaker-test' }),
    ).rejects.toThrow('Circuit breaker open');
  });

  it('passes timeout in options', async () => {
    const okResponse = new Response('ok', { status: 200 });
    mockFetch.mockResolvedValue(okResponse);

    await fetchWithRetry('https://example.com/api', { timeout: 5000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
