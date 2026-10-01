'use strict';

async function jsonFetch(url, opts = {}) {
  const baseHeaders = opts.body ? { 'content-type': 'application/json' } : {};
  const res = await fetch(url, {
    ...opts,
    headers: Object.assign(baseHeaders, opts.headers || {}),
  });
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

function makeClient(baseUrl) {
  return {
    async token(userId) {
      const r = await jsonFetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId }),
      });
      return r.body.token;
    },
    async createShow(adminToken, payload) {
      return jsonFetch(`${baseUrl}/shows`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(payload),
      });
    },
    async getShow(id, opts = {}) {
      const qs = opts.includeSeats === false ? '?include_seats=false' : '';
      return jsonFetch(`${baseUrl}/shows/${id}${qs}`);
    },
    async reserve(token, showId, payload, extraHeaders = {}) {
      return jsonFetch(`${baseUrl}/shows/${showId}/reserve`, {
        method: 'POST',
        headers: Object.assign({ authorization: `Bearer ${token}` }, extraHeaders),
        body: JSON.stringify(payload),
      });
    },
    async cancel(token, reservationId) {
      return jsonFetch(`${baseUrl}/reservations/${reservationId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    },
    async confirm(token, reservationId) {
      return jsonFetch(`${baseUrl}/reservations/${reservationId}/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    },
    async getReservation(token, reservationId) {
      return jsonFetch(`${baseUrl}/reservations/${reservationId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    },
  };
}

module.exports = { jsonFetch, makeClient };
