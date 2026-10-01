'use strict';

const { Pool } = require('pg');

const READY_TIMEOUT_MS = 2000;

async function healthRoutes(app, { pool, state }) {
  // Readiness gets its OWN single connection. If it shared the request pool, a burst
  // would queue the probe behind thousands of reservations, it would time out, and the
  // platform would mark a perfectly healthy instance as down and start dropping
  // traffic at the proxy (observed on Render). The question readiness answers is
  // "is the database reachable?", not "is the request pool busy?" — pool saturation
  // is reported separately via db_pool_waiting.
  const probePool = new Pool({
    ...pool.options,
    max: 1,
    connectionTimeoutMillis: READY_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
  });
  probePool.on('error', () => {}); // idle-client errors surface on the next probe instead
  app.addHook('onClose', async () => {
    await probePool.end().catch(() => {});
  });

  // A landing response for the bare live URL, so it doesn't read as a 404.
  app.get('/', async () => {
    return {
      service: 'seat-reservation',
      status: 'ok',
      repo: 'https://github.com/prashamm15/seat-reservation',
      endpoints: {
        'POST /auth/token': 'demo identity provider: {"user_id"} -> bearer token',
        'POST /shows': 'admin: create a show',
        'GET /shows/:id': 'per-seat status, counts, invariant + reconciliation',
        'POST /shows/:id/reserve': 'reserve seats (all-or-nothing, idempotent)',
        'POST /reservations/:id/cancel': 'owner only',
        'POST /reservations/:id/confirm': 'owner only, converts a hold',
        'GET /reservations/:id': 'owner only',
        'GET /healthz': 'liveness',
        'GET /readyz': 'readiness (checks the database, fails closed)',
        'GET /metrics': 'Prometheus metrics',
        'GET /logs': 'recent structured logs (?request_id=&limit=&level=)',
      },
    };
  });

  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  app.get('/readyz', async (req, reply) => {
    if (!state.migrated) {
      return reply.code(503).send({ status: 'not_ready', db: 'migrations not yet applied' });
    }
    try {
      const queryPromise = probePool.query('SELECT 1');
      // Avoid an unhandled rejection if the timeout wins the race and the
      // real query rejects later (e.g. a slow DNS failure against a bad host).
      queryPromise.catch(() => {});
      await Promise.race([
        queryPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db check timed out')), READY_TIMEOUT_MS)),
      ]);
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', db: err.message });
    }
  });
}

module.exports = healthRoutes;
