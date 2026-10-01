'use strict';

const { createPool, runMigrations } = require('../../src/db');
const { buildApp } = require('../../src/app');

async function startTestApp(databaseUrl, { skipMigrate, poolMax = 15 } = {}) {
  const pool = createPool({ databaseUrl, max: poolMax, ssl: false });
  const state = { migrated: false };
  if (!skipMigrate) {
    await runMigrations(pool);
    state.migrated = true;
  }
  const app = buildApp({ pool, state });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    pool,
    baseUrl,
    state,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

module.exports = { startTestApp };
