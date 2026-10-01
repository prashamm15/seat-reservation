'use strict';

const crypto = require('crypto');
const Fastify = require('fastify');

const config = require('./config');
const { loggerInstance } = require('./logger');
const metrics = require('./metrics');
const { AppError } = require('./errors');
const { isTransientInfraError, isDbUnavailableError } = require('./lib/retry');

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function genReqId(rawReq) {
  const incoming = rawReq.headers['x-request-id'];
  if (typeof incoming === 'string' && REQUEST_ID_RE.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

/**
 * Builds a Fastify app instance. `pool` and `state` are injected so tests can
 * point multiple independent instances at different databases, and so dev/
 * prod can share the exact same wiring.
 */
function buildApp({ pool, state }) {
  metrics.setPool(pool);

  const app = Fastify({
    loggerInstance,
    genReqId,
    requestIdHeader: 'x-request-id',
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024, // 1MB - sane cap for JSON API bodies
    trustProxy: true,
  });

  app.decorate('pool', pool);
  app.decorate('appState', state);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id);
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = (req.routeOptions && req.routeOptions.url) || req.raw.url || 'unknown';
    const status = String(reply.statusCode);
    metrics.httpRequestsTotal.inc({ method: req.method, route, status });
    const seconds = reply.elapsedTime ? reply.elapsedTime / 1000 : 0;
    metrics.httpRequestDuration.observe({ method: req.method, route, status }, seconds);
    if (reply.statusCode >= 500) {
      metrics.http5xxTotal.inc();
    }
    req.log.info(
      {
        method: req.method,
        route,
        status: reply.statusCode,
        ms: Math.round(seconds * 1000),
      },
      'access'
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send(Object.assign({ error: err.code, message: err.message }, err.extra));
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    if (err instanceof SyntaxError || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(400).send({ error: 'invalid_request', message: 'malformed request body' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'invalid_request', message: err.message });
    }
    if (isDbUnavailableError(err)) {
      // Fail closed: the system of record is unreachable, so nothing was decided or written.
      req.log.error({ err: err.message }, 'database unavailable');
      reply.header('Retry-After', '5');
      return reply.code(503).send({ error: 'database_unavailable', message: 'the database is unreachable; nothing was changed, retry with the same idempotency key' });
    }
    if (isTransientInfraError(err)) {
      // Belt-and-suspenders: the main reserve/cancel/confirm transactions already
      // convert these themselves (with a more specific error body), but a handful of
      // queries run outside those blocks (the show lookup, the fast-path pre-check,
      // the idempotency-key lookup). The spec requires zero 5xx even under a ~20k
      // burst, so ANY query that times out waiting on a lock or a pool connection
      // under extreme contention must still resolve to a retryable 429, never a 500.
      req.log.warn({ err: err.message }, 'transient infra error outside the main transaction, shedding load');
      if (req.routeOptions && req.routeOptions.url === '/shows/:id/reserve') {
        metrics.reservationsDeclinedTotal.inc({ reason: 'overloaded' });
      }
      reply.header('Retry-After', '1');
      return reply.code(429).send({ error: 'busy', message: 'system is under heavy load, please retry' });
    }
    req.log.error({ err: err.message, stack: err.stack }, 'unhandled error');
    // http_5xx_total is incremented once, in the onResponse hook — not here too.
    return reply.code(500).send({ error: 'internal_error', message: 'an unexpected error occurred' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'route not found' });
  });

  app.register(require('./routes/health'), { pool, state });
  app.register(require('./routes/metrics'));
  app.register(require('./routes/logs'));
  app.register(require('./routes/auth'), { config });
  app.register(require('./routes/shows'), { config });
  app.register(require('./routes/reservations'), { config });

  return app;
}

module.exports = { buildApp };
