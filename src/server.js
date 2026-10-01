'use strict';

const config = require('./config');
const { buildApp } = require('./app');
const { createPool, resolveSsl, startMigrationLoop } = require('./db');
const { createSweeperLoop } = require('./lib/sweeper');
const metrics = require('./metrics');
const { flushLogs } = require('./logger');

async function startServer() {
  if (config.isProd && !config.databaseUrl) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production');
  }

  const pool = createPool({
    databaseUrl: config.databaseUrl,
    max: config.pgPoolMax,
    ssl: await resolveSsl(config.databaseUrl, config.databaseSsl),
  });

  const state = { migrated: false };

  const app = buildApp({ pool, state });

  const migrationLoop = startMigrationLoop(pool, state, app.log);
  const sweeper = createSweeperLoop(pool, { intervalMs: 2000, logger: app.log, metrics });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info({ port: config.port }, 'server listening');

  async function close() {
    migrationLoop.stop();
    sweeper.stop();
    await app.close();
    await pool.end();
  }

  return { app, pool, close };
}

if (require.main === module) {
  const started = startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('failed to start server', err);
    process.exit(1);
  });

  // Graceful shutdown (e.g. a redeploy): stop accepting connections, let in-flight
  // reservations finish their transactions, close the pool, then exit.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), 10000).unref();
    started
      .then((srv) => srv && (srv.app.log.info({ signal }, 'shutting down'), srv.close()))
      .then(() => { flushLogs(); process.exit(0); }, () => { flushLogs(); process.exit(1); });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { startServer };
