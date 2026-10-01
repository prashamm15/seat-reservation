'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { jsonFetch, makeClient } = require('./helpers/client');

test('auth', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('mints a token for a valid user_id', async () => {
    const r = await jsonFetch(`${server.baseUrl}/auth/token`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'alice' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.user_id, 'alice');
    assert.ok(r.body.token.split('.').length === 3);
  });

  await t.test('rejects an invalid user_id', async () => {
    const r = await jsonFetch(`${server.baseUrl}/auth/token`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'has a space' }),
    });
    assert.equal(r.status, 400);
  });

  await t.test('a user endpoint without a token is 401', async () => {
    const r = await jsonFetch(`${server.baseUrl}/shows/00000000-0000-0000-0000-000000000000/reserve`, {
      method: 'POST',
      body: JSON.stringify({ seats: ['A1'], idempotency_key: 'k' }),
    });
    assert.equal(r.status, 401);
  });

  await t.test('admin endpoint with no token is 401, with a user token is 403', async () => {
    const noAuth = await jsonFetch(`${server.baseUrl}/shows`, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', seats: ['A1'], price_paise: 100 }),
    });
    assert.equal(noAuth.status, 401);

    const userToken = await client.token('bob');
    const wrongAuth = await client.createShow(userToken, { name: 'x', seats: ['A1'], price_paise: 100 });
    assert.equal(wrongAuth.status, 403);
  });

  await t.test('admin endpoint with the correct admin token succeeds', async () => {
    const r = await client.createShow(require('../src/config').adminToken, {
      name: 'Admin Auth Test',
      seats: ['A1', 'A2'],
      price_paise: 100,
    });
    assert.equal(r.status, 201);
  });
});
