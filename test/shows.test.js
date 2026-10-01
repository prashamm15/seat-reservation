'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = require('../src/config').adminToken;

test('shows: creation, validation, money, snapshot', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('creates a show with all seats available', async () => {
    const r = await client.createShow(ADMIN, { name: 'Hamilton', seats: ['A1', 'A2', 'A3'], price_paise: 25000 });
    assert.equal(r.status, 201);
    assert.equal(r.body.total_seats, 3);
    assert.equal(r.body.counts.available, 3);
    assert.equal(r.body.per_user_limit, 4); // default
    assert.ok(r.body.seats.every((s) => s.status === 'available'));
  });

  await t.test('rejects a float price', async () => {
    const r = await client.createShow(ADMIN, { name: 'x', seats: ['A1'], price_paise: 100.5 });
    assert.equal(r.status, 400);
  });

  await t.test('rejects a string price', async () => {
    const r = await client.createShow(ADMIN, { name: 'x', seats: ['A1'], price_paise: '100' });
    assert.equal(r.status, 400);
  });

  await t.test('rejects duplicate seat labels', async () => {
    const r = await client.createShow(ADMIN, { name: 'x', seats: ['A1', 'A1'], price_paise: 100 });
    assert.equal(r.status, 400);
  });

  await t.test('rejects an empty seats array', async () => {
    const r = await client.createShow(ADMIN, { name: 'x', seats: [], price_paise: 100 });
    assert.equal(r.status, 400);
  });

  await t.test('GET unknown uuid is 404, not a 500', async () => {
    const r = await client.getShow('00000000-0000-0000-0000-000000000000');
    assert.equal(r.status, 404);
  });

  await t.test('GET malformed id is 404, not a postgres 22P02 -> 500', async () => {
    const r = await client.getShow('not-a-uuid');
    assert.equal(r.status, 404);
  });

  await t.test('GET show snapshot: counts, invariant_ok, reconciliation', async () => {
    const created = await client.createShow(ADMIN, { name: 'Snap', seats: ['A1', 'A2', 'A3', 'A4'], price_paise: 1000 });
    const showId = created.body.id;

    const r = await client.getShow(showId);
    assert.equal(r.status, 200);
    assert.equal(r.body.counts.available + r.body.counts.held + r.body.counts.confirmed, r.body.counts.total);
    assert.equal(r.body.invariant_ok, true);
    assert.equal(r.body.reconciliation.ok, true);
    assert.equal(r.body.reconciliation.seats_held_or_confirmed, 0);
    assert.equal(r.body.reconciliation.seats_in_active_reservations, 0);
  });

  await t.test('include_seats=false omits the seat list', async () => {
    const created = await client.createShow(ADMIN, { name: 'NoSeats', seats: ['A1'], price_paise: 1000 });
    const r = await client.getShow(created.body.id, { includeSeats: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.seats, undefined);
  });

  await t.test('money: price * seats stays an exact integer, never a float', async () => {
    const created = await client.createShow(ADMIN, { name: 'Money', seats: ['A1', 'A2'], price_paise: 25000 });
    const token = await client.token('money-user');
    const r = await client.reserve(token, created.body.id, { seats: ['A1', 'A2'], idempotency_key: 'money-1' });
    assert.equal(r.status, 201);
    assert.equal(r.body.amount_paise, 50000);
    assert.equal(Number.isInteger(r.body.amount_paise), true);
  });
});
