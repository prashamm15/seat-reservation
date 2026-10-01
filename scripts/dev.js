#!/usr/bin/env node
'use strict';

// Boots an embedded Postgres instance + the Fastify server, entirely locally,
// no Docker required. Ctrl+C shuts both down cleanly.

const fs = require('fs');
const path = require('path');

async function main() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const dataDir = path.join(__dirname, '..', '.pgdata');
  const port = parseInt(process.env.DEV_PG_PORT || '55432', 10);

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'paytm',
    password: 'paytm',
    port,
    persistent: true,
  });

  console.log(`[dev] starting embedded Postgres on port ${port} (${dataDir})...`);
  // initialise() runs initdb, which FAILS on a non-empty directory — so only call it on
  // the first run; later runs reuse the existing cluster.
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase('paytm');
  } catch (e) {
    // already exists - fine on subsequent runs.
  }
  console.log('[dev] embedded Postgres ready');

  process.env.DATABASE_URL = process.env.DATABASE_URL || `postgresql://paytm:paytm@127.0.0.1:${port}/paytm`;

  const { startServer } = require('../src/server');
  const server = await startServer();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dev] received ${signal}, shutting down...`);
    try {
      await server.close();
    } catch (e) {
      console.error('[dev] error closing server', e);
    }
    try {
      await pg.stop();
    } catch (e) {
      console.error('[dev] error stopping postgres', e);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[dev] failed to start', err);
  process.exit(1);
});
