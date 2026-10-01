'use strict';

const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startEmbedded() {
  // embedded-postgres ships as an ESM-only package; dynamic import works fine
  // from this CommonJS test helper.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await getFreePort();
  const dir = path.join(os.tmpdir(), `paytm-pgtest-${crypto.randomBytes(6).toString('hex')}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'paytm',
    password: 'paytm',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('paytm');
  return { pg, dir, databaseUrl: `postgresql://paytm:paytm@127.0.0.1:${port}/paytm` };
}

/**
 * Returns a { databaseUrl, teardown } pair. If DATABASE_URL is already set
 * (e.g. the CI postgres service container), uses it directly and leaves its
 * lifecycle to whoever started it. Otherwise boots a throwaway embedded
 * Postgres instance on a free port.
 */
async function setupTestDb() {
  if (process.env.DATABASE_URL) {
    return { databaseUrl: process.env.DATABASE_URL, teardown: async () => {} };
  }
  const { pg, dir, databaseUrl } = await startEmbedded();
  return {
    databaseUrl,
    teardown: async () => {
      try {
        await pg.stop();
      } catch (e) {
        // best-effort
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // best-effort
      }
    },
  };
}

module.exports = { setupTestDb, getFreePort };
