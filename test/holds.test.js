'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');
const { sweepOnce } = require('../src/lib/sweeper');

const ADMIN = 'dev-admin-token';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('holds and expiry', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('hold:true creates a held reservation with expires_at, counted in held', async () => {
    const show = (await client.createShow(ADMIN, { name: 'HoldShow', seats: ['A1'], price_paise: 1000, hold_ttl_seconds: 120 })).body;
    const token = await client.token('holder1');

    const r = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'h1', hold: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'held');
    assert.ok(r.body.expires_at);

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.counts.held, 1);
    assert.equal(snap.body.counts.available, 0);
  });

  await t.test('confirm converts a held reservation to confirmed', async () => {
    const show = (await client.createShow(ADMIN, { name: 'HoldShow2', seats: ['A1'], price_paise: 1000, hold_ttl_seconds: 120 })).body;
    const token = await client.token('holder2');

    const r = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'h2', hold: true });
    const confirmed = await client.confirm(token, r.body.reservation_id);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, 'confirmed');

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.seats.find((s) => s.label === 'A1').status, 'confirmed');
  });

  await t.test('after a 1s hold expires, a different user can reserve it; original owner gets hold_expired/not_active', async () => {
    const show = (await client.createShow(ADMIN, { name: 'ShortHold', seats: ['A1'], price_paise: 1000, hold_ttl_seconds: 1 })).body;
    const first = await client.token('short-holder');
    const second = await client.token('short-second');

    const held = await client.reserve(first, show.id, { seats: ['A1'], idempotency_key: 'sh1', hold: true });
    assert.equal(held.status, 201);
    assert.equal(held.body.status, 'held');

    await sleep(1200);

    const snapBefore = await client.getShow(show.id);
    assert.equal(snapBefore.body.seats.find((s) => s.label === 'A1').status, 'available');

    const taken = await client.reserve(second, show.id, { seats: ['A1'], idempotency_key: 'sh2' });
    assert.equal(taken.status, 201);
    assert.equal(taken.body.status, 'confirmed');

    const confirmAttempt = await client.confirm(first, held.body.reservation_id);
    assert.equal(confirmAttempt.status, 409);
    assert.equal(confirmAttempt.body.error, 'hold_expired');

    const cancelAttempt = await client.cancel(first, held.body.reservation_id);
    assert.equal(cancelAttempt.status, 409);
    assert.equal(cancelAttempt.body.error, 'not_active');

    // The seat must stay confirmed to the new owner - never resurrected to the expired holder.
    const snapAfter = await client.getShow(show.id);
    assert.equal(snapAfter.body.seats.find((s) => s.label === 'A1').status, 'confirmed');
  });

  await t.test('confirm on a reservation that was never held (already confirmed) is 409 not_held', async () => {
    const show = (await client.createShow(ADMIN, { name: 'AlreadyConfirmed', seats: ['A1'], price_paise: 1000 })).body;
    const token = await client.token('direct-confirm-user');

    const r = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'dc1' });
    assert.equal(r.body.status, 'confirmed');

    const confirmAgain = await client.confirm(token, r.body.reservation_id);
    assert.equal(confirmAgain.status, 409);
    assert.equal(confirmAgain.body.error, 'not_held');
  });

  await t.test('the sweeper function directly releases expired holds', async () => {
    const show = (await client.createShow(ADMIN, { name: 'SweepDirect', seats: ['A1', 'A2'], price_paise: 1000, hold_ttl_seconds: 1 })).body;
    const token = await client.token('sweep-user');

    const r = await client.reserve(token, show.id, { seats: ['A1', 'A2'], idempotency_key: 'sweep1', hold: true });
    assert.equal(r.status, 201);

    await sleep(1200);

    const result = await sweepOnce(server.pool);
    assert.ok(result.seatsExpired >= 2);
    assert.ok(result.reservationsExpired >= 1);

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.seats.find((s) => s.label === 'A1').status, 'available');
    assert.equal(snap.body.seats.find((s) => s.label === 'A2').status, 'available');
  });
});
