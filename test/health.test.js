'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { jsonFetch } = require('./helpers/client');

test('health and readiness', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('liveness is always 200', async () => {
    const r = await jsonFetch(`${server.baseUrl}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });

  await t.test('readiness is 200 once migrated and db reachable', async () => {
    const r = await jsonFetch(`${server.baseUrl}/readyz`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ready');
  });
});

test('readiness fails closed when the DB is unreachable', async (t) => {
  // An unreachable DB: never migrated, and any query against it will fail/time out.
  const server = await startTestApp('postgresql://nouser:nopass@127.0.0.1:1/nodb', { skipMigrate: true });
  t.after(async () => {
    await server.close();
  });

  const r = await jsonFetch(`${server.baseUrl}/readyz`);
  assert.equal(r.status, 503);
  assert.equal(r.body.status, 'not_ready');

  // Liveness must still be fine - it never touches the DB.
  const live = await jsonFetch(`${server.baseUrl}/healthz`);
  assert.equal(live.status, 200);

  // Writes fail closed with an explicit 503, not a generic 500 "unexpected error".
  const show = await jsonFetch(`${server.baseUrl}/shows/00000000-0000-4000-8000-000000000000`);
  assert.equal(show.status, 503);
  assert.equal(show.body.error, 'database_unavailable');
  assert.ok(show.headers.get('retry-after'));
});

// Regression (seen live on Render): readiness used the request pool, so under a
// burst the probe queued behind reservations, timed out, and the platform marked
// a healthy instance as down. Readiness must stay 200 while the pool is saturated.
test('readiness stays 200 while every request-pool connection is busy', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl, { poolMax: 2 });
  const held = [await server.pool.connect(), await server.pool.connect()];
  t.after(async () => {
    held.forEach((c) => c.release());
    await server.close();
    await db.teardown();
  });

  assert.equal(server.pool.idleCount, 0);
  const r = await jsonFetch(`${server.baseUrl}/readyz`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('the bare live URL answers 200 with an endpoint index, not a 404', async (t) => {
  const server = await startTestApp('postgresql://nouser:nopass@127.0.0.1:1/nodb', { skipMigrate: true });
  t.after(async () => {
    await server.close();
  });
  const r = await jsonFetch(`${server.baseUrl}/`);
  assert.equal(r.status, 200);
  assert.equal(r.body.service, 'seat-reservation');
  assert.ok(r.body.endpoints['POST /shows/:id/reserve']);
});
