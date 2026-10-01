'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = require('../src/config').adminToken;

async function freshShow(client, seats, overrides = {}) {
  const r = await client.createShow(ADMIN, Object.assign({ name: 'Show', seats, price_paise: 1000 }, overrides));
  return r.body;
}

test('reserve: basics, identity, cancel, all-or-nothing', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('all-or-nothing: if any requested seat is taken, nothing is reserved', async () => {
    const show = await freshShow(client, ['A1', 'A2', 'A3']);
    const u1 = await client.token('u1');
    const u2 = await client.token('u2');

    const first = await client.reserve(u1, show.id, { seats: ['A1'], idempotency_key: 'k1' });
    assert.equal(first.status, 201);

    const second = await client.reserve(u2, show.id, { seats: ['A1', 'A2'], idempotency_key: 'k2' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'seat_unavailable');
    assert.deepEqual(second.body.unavailable, ['A1']);

    // A2 must NOT have been claimed by the failed all-or-nothing attempt.
    const snapshot = await client.getShow(show.id);
    const a2 = snapshot.body.seats.find((s) => s.label === 'A2');
    assert.equal(a2.status, 'available');
  });

  await t.test('identity: body user_id is ignored, identity comes only from the token', async () => {
    const show = await freshShow(client, ['B1']);
    const x = await client.token('userX');
    const y = await client.token('userY');

    const r = await client.reserve(y, show.id, { seats: ['B1'], idempotency_key: 'spoof', user_id: x });
    assert.equal(r.status, 201);
    assert.equal(r.body.user_id, 'userY'); // not userX, despite the spoofed body field
  });

  await t.test('cancel: forbidden for a non-owner, ok for the owner, 409 on double cancel', async () => {
    const show = await freshShow(client, ['C1']);
    const owner = await client.token('owner1');
    const stranger = await client.token('stranger1');

    const made = await client.reserve(owner, show.id, { seats: ['C1'], idempotency_key: 'c1' });
    assert.equal(made.status, 201);

    const forbidden = await client.cancel(stranger, made.body.reservation_id);
    assert.equal(forbidden.status, 403);

    const ok = await client.cancel(owner, made.body.reservation_id);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'cancelled');

    const twice = await client.cancel(owner, made.body.reservation_id);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, 'not_active');
  });

  await t.test('cancel makes the seat available and re-bookable by someone else', async () => {
    const show = await freshShow(client, ['D1']);
    const owner = await client.token('owner2');
    const other = await client.token('other2');

    const made = await client.reserve(owner, show.id, { seats: ['D1'], idempotency_key: 'd1' });
    await client.cancel(owner, made.body.reservation_id);

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.seats.find((s) => s.label === 'D1').status, 'available');

    const rebooked = await client.reserve(other, show.id, { seats: ['D1'], idempotency_key: 'd2' });
    assert.equal(rebooked.status, 201);
  });

  await t.test('cancel/confirm/get on an unknown reservation id is 404', async () => {
    const owner = await client.token('owner3');
    const unknownId = '00000000-0000-0000-0000-000000000000';
    assert.equal((await client.cancel(owner, unknownId)).status, 404);
    assert.equal((await client.confirm(owner, unknownId)).status, 404);
    assert.equal((await client.getReservation(owner, unknownId)).status, 404);
  });

  await t.test('get reservation is owner-only', async () => {
    const show = await freshShow(client, ['E1']);
    const owner = await client.token('owner4');
    const stranger = await client.token('stranger4');
    const made = await client.reserve(owner, show.id, { seats: ['E1'], idempotency_key: 'e1' });

    assert.equal((await client.getReservation(owner, made.body.reservation_id)).status, 200);
    assert.equal((await client.getReservation(stranger, made.body.reservation_id)).status, 403);
  });

  await t.test('reserve on an unknown show is 404', async () => {
    const owner = await client.token('owner5');
    const r = await client.reserve(owner, '00000000-0000-0000-0000-000000000000', {
      seats: ['A1'],
      idempotency_key: 'x',
    });
    assert.equal(r.status, 404);
  });

  await t.test('reserve against an unknown seat label is 400 unknown_seat', async () => {
    const show = await freshShow(client, ['F1']);
    const owner = await client.token('owner6');
    const r = await client.reserve(owner, show.id, { seats: ['ZZZ'], idempotency_key: 'f1' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'unknown_seat');
  });

  await t.test('missing idempotency_key is 400', async () => {
    const show = await freshShow(client, ['G1']);
    const owner = await client.token('owner7');
    const r = await client.reserve(owner, show.id, { seats: ['G1'] });
    assert.equal(r.status, 400);
  });

  await t.test('Idempotency-Key header works, and disagreeing with the body is 400', async () => {
    const show = await freshShow(client, ['H1', 'H2']);
    const owner = await client.token('owner8');

    const viaHeader = await client.reserve(owner, show.id, { seats: ['H1'] }, { 'idempotency-key': 'hdr-1' });
    assert.equal(viaHeader.status, 201);

    const mismatch = await client.reserve(
      owner,
      show.id,
      { seats: ['H2'], idempotency_key: 'body-key' },
      { 'idempotency-key': 'different-header-key' }
    );
    assert.equal(mismatch.status, 400);
  });
});
