'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// A fixed, arbitrary key used for the migration advisory lock so that concurrent
// app instances booting at once never race to apply the schema twice.
const MIGRATION_LOCK_KEY = 827364501;

function createPool({ databaseUrl, max, ssl, logger }) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: max || 20,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 60000,
    idleTimeoutMillis: 30000,
  });

  pool.on('connect', (client) => {
    // lock_timeout is deliberately short: under hot-row contention (many transactions
    // racing to FOR UPDATE the same seat) a short timeout fails the loser fast so its
    // pool connection is freed for the next attempt instead of parking it for seconds
    // waiting on a lock it is very likely to lose anyway. withRetry() then retries a
    // 55P03 quickly with jitter, which keeps overall pool turnover high under a burst.
    client.query('SET statement_timeout = 10000').catch(() => {});
    client.query('SET lock_timeout = 3000').catch(() => {});
  });

  pool.on('error', (err) => {
    if (logger) logger.error({ err: err.message }, 'idle pg client error');
  });

  return pool;
}

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const sqlPath = path.join(__dirname, '..', 'migrations', '001_init.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps retrying migrations with backoff until they succeed. Never throws.
 * Liveness must stay 200 while this runs in the background; readiness stays
 * 503 until `state.migrated` flips true.
 */
function startMigrationLoop(pool, state, logger) {
  let stopped = false;
  const promise = (async () => {
    let attempt = 0;
    while (!stopped && !state.migrated) {
      try {
        await runMigrations(pool);
        state.migrated = true;
        if (logger) logger.info('migrations applied');
      } catch (err) {
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        if (logger) logger.error({ err: err.message, attempt }, 'migration attempt failed, retrying');
        await sleep(delay);
      }
    }
  })();
  return {
    promise,
    stop() {
      stopped = true;
    },
  };
}

module.exports = { createPool, runMigrations, startMigrationLoop };
