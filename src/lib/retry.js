'use strict';

// Postgres error codes that indicate a transaction can be safely retried.
const RETRYABLE_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` up to maxAttempts times, retrying only on known-retryable Postgres
 * errors with a small amount of jitter between attempts.
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 20 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_CODES.has(err && err.code) || attempt === maxAttempts) {
        throw err;
      }
      const jitter = Math.random() * baseDelayMs;
      await sleep(baseDelayMs * attempt + jitter);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, RETRYABLE_CODES };
