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

/**
 * True for infra-level hiccups under extreme load (lock/statement timeouts that
 * survived every retry, or the pg pool itself failing to hand out a connection in
 * time). The spec requires zero 5xx even under a ~20k-request burst, so every call
 * site that can hit these must treat them as a decline, never let them become an
 * unhandled 500.
 */
function isTransientInfraError(err) {
  if (!err) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (err.code === '57014') return true; // statement_timeout
  const msg = String(err.message || '');
  if (/timeout exceeded when trying to connect/i.test(msg)) return true;
  if (/connection terminated/i.test(msg)) return true;
  if (/too many clients/i.test(msg)) return true;
  return false;
}

module.exports = { withRetry, RETRYABLE_CODES, isTransientInfraError };
