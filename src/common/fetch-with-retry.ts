import { getCircuitBreaker } from './circuit-breaker';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: Error | Response) => void;
  circuitBreakerName?: string;
}

export async function fetchWithRetry(
  url: string | URL,
  options?: RequestInit & { timeout?: number },
  retryOptions?: RetryOptions,
): Promise<Response> {
  const { timeout, ...fetchOptions } = options || {};
  const maxRetries = retryOptions?.maxRetries ?? 3;
  const baseDelayMs = retryOptions?.baseDelayMs ?? 1000;
  const onRetry = retryOptions?.onRetry;
  const cbName = retryOptions?.circuitBreakerName;

  let lastError: Error | null = null;
  let controller: AbortController;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const execute = async (): Promise<Response> => {
    controller = new AbortController();
    timeoutId = timeout
      ? setTimeout(() => controller.abort(), timeout)
      : undefined;

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      return response;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let response: Response;

      if (cbName) {
        const cb = getCircuitBreaker(cbName);
        response = await cb.call(execute);
      } else {
        response = await execute();
      }

      if (response.ok) return response;

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
        return response;
      }

      onRetry?.(attempt, response);
      await delay(baseDelayMs * Math.pow(2, attempt - 1));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeout}ms`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt === maxRetries) break;

      onRetry?.(attempt, lastError);
      await delay(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }

  throw lastError || new Error('Request failed after retries');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
