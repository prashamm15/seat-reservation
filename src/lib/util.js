'use strict';

const crypto = require('crypto');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Constant-time string comparison that tolerates differing lengths safely. */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a timingSafeEqual of equal length to avoid an easy length-based timing leak.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** sha256 of the canonical request shape used for idempotency replay detection. */
function canonicalRequestHash({ showId, seats, hold }) {
  const sortedSeats = [...new Set(seats)].sort();
  const obj = { show_id: showId, seats: sortedSeats, hold: !!hold };
  const json = JSON.stringify(obj);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/** Converts a bigint-as-string (as returned by pg for bigint columns) into a safe integer. */
function toSafeInt(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    // Extremely unlikely for this domain (paise amounts), but never silently truncate.
    return n.toString();
  }
  return Number(n);
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

module.exports = {
  isValidUuid,
  safeCompare,
  canonicalRequestHash,
  toSafeInt,
  extractBearerToken,
};
