'use strict';

const { toSafeInt } = require('./util');

// Rows come either from pg (Date objects) or from row_to_json in the fast path
// (strings like "2026-10-01T12:26:30.66+00:00"). Normalise both to the same ISO form
// so an idempotent replay is byte-identical to the original response.
function iso(v) {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function serializeReservation(row, extra = {}) {
  const out = {
    reservation_id: row.id,
    show_id: row.show_id,
    user_id: row.user_id,
    seats: row.seats,
    amount_paise: toSafeInt(row.amount_paise),
    status: row.status,
  };
  if (row.expires_at) {
    out.expires_at = iso(row.expires_at);
  }
  if (row.created_at) {
    out.created_at = iso(row.created_at);
  }
  if (row.updated_at) {
    out.updated_at = iso(row.updated_at);
  }
  return Object.assign(out, extra);
}

module.exports = { serializeReservation };
