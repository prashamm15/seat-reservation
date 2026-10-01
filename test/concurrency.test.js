'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = 'dev-admin-token';

test('concurrency: hot seat, multi-seat overlap, per-user limit', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('hot seat: 200 concurrent users, exactly one 201, rest 409, zero 5xx', async () => {
    const show = (await client.createShow(ADMIN, { name: 'Hot', seats: ['HOT1'], price_paise: 1000 })).body;
    const tokens = await Promise.all(Array.from({ length: 200 }, (_, i) => client.token(`hot-user-${i}`)));

    const results = await Promise.all(
      tokens.map((tok, i) => client.reserve(tok, show.id, { seats: ['HOT1'], idempotency_key: `hot-${i}` }))
    );

    const created = results.filter((r) => r.status === 201);
    const declined = results.filter((r) => r.status === 409);
    const serverErrors = results.filter((r) => r.status >= 500);

    assert.equal(created.length, 1);
    assert.equal(declined.length, 199);
    assert.equal(serverErrors.length, 0);
    assert.ok(declined.every((r) => r.body.error === 'seat_unavailable'));

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.seats.find((s) => s.label === 'HOT1').status, 'confirmed');
  });

  await t.test('multi-seat all-or-nothing under concurrency: no seat is double-confirmed, no deadlocks', async () => {
    const seatLabels = Array.from({ length: 10 }, (_, i) => `M${i + 1}`);
    const show = (await client.createShow(ADMIN, { name: 'Overlap', seats: seatLabels, price_paise: 1000, per_user_limit: 20 })).body;

    // Overlapping pairs: [M1,M2], [M2,M3], [M3,M4], ... deliberately contend on shared seats.
    const pairs = [];
    for (let i = 0; i < seatLabels.length - 1; i++) {
      pairs.push([seatLabels[i], seatLabels[i + 1]]);
    }
    // Fire each pair from many distinct users, all concurrently.
    const attempts = [];
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < pairs.length; i++) {
        attempts.push({ pair: pairs[i], userIdx: round * pairs.length + i });
      }
    }
    const tokens = await Promise.all(attempts.map((a) => client.token(`overlap-user-${a.userIdx}`)));

    const results = await Promise.all(
      attempts.map((a, i) =>
        client.reserve(tokens[i], show.id, { seats: a.pair, idempotency_key: `overlap-${i}` })
      )
    );

    const serverErrors = results.filter((r) => r.status >= 500);
    assert.equal(serverErrors.length, 0, 'no 5xx under contention');

    const snap = await client.getShow(show.id);
    assert.equal(snap.body.invariant_ok, true);
    assert.equal(snap.body.reconciliation.ok, true);

    // Every individual seat must end up confirmed at most once - i.e. never over-sold.
    const confirmedCount = snap.body.seats.filter((s) => s.status === 'confirmed').length;
    const successfulSeats = results.filter((r) => r.status === 201).reduce((sum, r) => sum + r.body.seats.length, 0);
    assert.equal(confirmedCount, successfulSeats);
  });

  await t.test('per-user limit: 10 parallel single-seat reserves on a limit-4 show, exactly 4 succeed', async () => {
    const seatLabels = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const show = (await client.createShow(ADMIN, { name: 'LimitShow', seats: seatLabels, price_paise: 1000, per_user_limit: 4 })).body;
    const token = await client.token('limit-user');

    const results = await Promise.all(
      seatLabels.map((label, i) => client.reserve(token, show.id, { seats: [label], idempotency_key: `limit-${i}` }))
    );

    const created = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 409 && r.body.error === 'per_user_limit');

    assert.equal(created.length, 4);
    assert.equal(limited.length, 6);

    // Verify independently via GET on each created reservation.
    for (const r of created) {
      const got = await client.getReservation(token, r.body.reservation_id);
      assert.equal(got.status, 200);
      assert.equal(got.body.status, 'confirmed');
    }
  });

  await t.test('per-user limit: holding 2 then requesting 3 more at once is rejected', async () => {
    const show = (await client.createShow(ADMIN, { name: 'LimitShow2', seats: ['N1', 'N2', 'N3', 'N4', 'N5'], price_paise: 1000, per_user_limit: 4 })).body;
    const token = await client.token('limit-user-2');

    const first = await client.reserve(token, show.id, { seats: ['N1', 'N2'], idempotency_key: 'first' });
    assert.equal(first.status, 201);

    const second = await client.reserve(token, show.id, { seats: ['N3', 'N4', 'N5'], idempotency_key: 'second' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'per_user_limit');
    assert.equal(second.body.current, 2);
  });
});
