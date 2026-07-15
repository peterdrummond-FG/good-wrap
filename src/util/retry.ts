// Generic retry-with-backoff helper for transient failures in external calls
// (a flaky Claude API response, a first-time model download hiccup, etc).
//
// Added after the manual "Reprocess meeting" button intermittently returned
// a 400 that succeeded immediately on a plain retry with identical input —
// the signature of a transient blip rather than a real bug. `extractInsights`
// (Claude API) and `embedChunks` (local model load + inference) are the two
// external calls in the Stage 2 pipeline, so both are wrapped with this.
//
// Not meant for errors that are guaranteed to recur (e.g. missing required
// input, a real validation failure) — those should still throw immediately
// and not be retried by callers.

export interface RetryOptions {
  /** Number of retries *after* the first attempt. Default 2 (3 attempts total). */
  retries?: number;
  /** Delay before the first retry, in ms. Doubles after each subsequent retry. */
  baseDelayMs?: number;
  /** Called before each retry (not on the final failure) — useful for logging. */
  onRetry?: (err: unknown, attempt: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 1000, onRetry } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      onRetry?.(err, attempt + 1);
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
