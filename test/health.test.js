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
});
