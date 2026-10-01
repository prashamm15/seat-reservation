'use strict';

const config = require('./config');
const { buildApp } = require('./app');
const { createPool, startMigrationLoop } = require('./db');
const { createSweeperLoop } = require('./lib/sweeper');
const metrics = require('./metrics');

async function startServer() {
  if (config.isProd && !config.databaseUrl) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production');
  }

  const pool = createPool({
    databaseUrl: config.databaseUrl,
    max: config.pgPoolMax,
    ssl: config.databaseSsl,
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
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('failed to start server', err);
    process.exit(1);
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

module.exports = { startServer };
