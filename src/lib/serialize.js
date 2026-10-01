'use strict';

const { toSafeInt } = require('./util');

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
    out.expires_at = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
  }
  if (row.created_at) {
    out.created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  }
  if (row.updated_at) {
    out.updated_at = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  }
  return Object.assign(out, extra);
}

module.exports = { serializeReservation };
