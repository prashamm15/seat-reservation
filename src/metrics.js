'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const reservationsConfirmedTotal = new client.Counter({
  name: 'reservations_confirmed_total',
  help: 'Reservations that reached 201 (a brand new reservation, not a replay)',
  labelNames: ['mode'],
  registers: [register],
});

const reservationsDeclinedTotal = new client.Counter({
  name: 'reservations_declined_total',
  help: 'Reserve attempts that did not result in a brand-new confirmed/held reservation',
  labelNames: ['reason'],
  registers: [register],
});

const reservationsCancelledTotal = new client.Counter({
  name: 'reservations_cancelled_total',
  help: 'Reservations successfully cancelled',
  registers: [register],
});

const holdsConfirmedTotal = new client.Counter({
  name: 'holds_confirmed_total',
  help: 'Holds successfully converted to confirmed reservations',
  registers: [register],
});

const holdsExpiredSeatsTotal = new client.Counter({
  name: 'holds_expired_seats_total',
  help: 'Seats released by the expiry sweeper because their hold expired',
  registers: [register],
});

const seatsConfirmedTotal = new client.Counter({
  name: 'seats_confirmed_total',
  help: 'Individual seats (not reservations) that became confirmed',
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const http5xxTotal = new client.Counter({
  name: 'http_5xx_total',
  help: 'Total HTTP responses with a 5xx status code',
  registers: [register],
});

const dbPoolTotal = new client.Gauge({
  name: 'db_pool_total',
  help: 'Total number of clients in the pg pool',
  registers: [register],
});

const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle',
  help: 'Number of idle clients in the pg pool',
  registers: [register],
});

const dbPoolWaiting = new client.Gauge({
  name: 'db_pool_waiting',
  help: 'Number of queued requests waiting for a client',
  registers: [register],
});

// Seat-state gauges, collected at scrape time for the 20 most recently created shows,
// so they always reconcile with GET /shows/:id rather than drifting between events.
const showSeats = new client.Gauge({
  name: 'show_seats',
  help: 'Current seat count per show per effective state',
  labelNames: ['show_id', 'state'],
  registers: [register],
  async collect() {
    const pool = metrics._pool;
    if (!pool) return;
    try {
      const { rows } = await pool.query(`
        SELECT s.show_id,
               count(*) FILTER (WHERE s.status = 'available' OR (s.status = 'held' AND s.held_until <= now())) AS available,
               count(*) FILTER (WHERE s.status = 'held' AND s.held_until > now()) AS held,
               count(*) FILTER (WHERE s.status = 'confirmed') AS confirmed
        FROM seats s
        WHERE s.show_id IN (SELECT id FROM shows ORDER BY created_at DESC LIMIT 20)
        GROUP BY s.show_id
      `);
      for (const row of rows) {
        this.set({ show_id: row.show_id, state: 'available' }, Number(row.available));
        this.set({ show_id: row.show_id, state: 'held' }, Number(row.held));
        this.set({ show_id: row.show_id, state: 'confirmed' }, Number(row.confirmed));
      }
    } catch (e) {
      // metrics must never throw and break scraping
    }
  },
});

const showSeatsTotal = new client.Gauge({
  name: 'show_seats_total',
  help: 'Total seat count per show',
  labelNames: ['show_id'],
  registers: [register],
  async collect() {
    const pool = metrics._pool;
    if (!pool) return;
    try {
      const { rows } = await pool.query(`
        SELECT id AS show_id, total_seats
        FROM shows
        ORDER BY created_at DESC
        LIMIT 20
      `);
      for (const row of rows) {
        this.set({ show_id: row.show_id }, Number(row.total_seats));
      }
    } catch (e) {
      // ignore
    }
  },
});

const metrics = {
  register,
  reservationsConfirmedTotal,
  reservationsDeclinedTotal,
  reservationsCancelledTotal,
  holdsConfirmedTotal,
  holdsExpiredSeatsTotal,
  seatsConfirmedTotal,
  httpRequestsTotal,
  httpRequestDuration,
  http5xxTotal,
  dbPoolTotal,
  dbPoolIdle,
  dbPoolWaiting,
  showSeats,
  showSeatsTotal,
  _pool: null,
  setPool(pool) {
    this._pool = pool;
  },
  updatePoolGauges(pool) {
    if (!pool) return;
    dbPoolTotal.set(pool.totalCount || 0);
    dbPoolIdle.set(pool.idleCount || 0);
    dbPoolWaiting.set(pool.waitingCount || 0);
  },
};

module.exports = metrics;
