'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = 'dev-admin-token';

test('idempotency', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  await t.test('same key + body, sequential: 201 then 200 replay with the same reservation_id', async () => {
    const show = (await client.createShow(ADMIN, { name: 'S', seats: ['A1'], price_paise: 500 })).body;
    const token = await client.token('seq-user');

    const first = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'seq-key' });
    assert.equal(first.status, 201);

    const replay = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'seq-key' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(replay.body.reservation_id, first.body.reservation_id);
    assert.equal(replay.body.idempotent_replay, true);
  });

  await t.test('same key fired 20x concurrently: exactly one reservation row, one 201, rest replays', async () => {
    const show = (await client.createShow(ADMIN, { name: 'S2', seats: ['A1'], price_paise: 500 })).body;
    const token = await client.token('concurrent-user');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'concurrent-key' }))
    );

    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    assert.equal(created.length, 1);
    assert.equal(replayed.length, 19);

    const ids = new Set(results.map((r) => r.body.reservation_id));
    assert.equal(ids.size, 1);
  });

  await t.test('same key, different seats: 409 idempotency_key_reused', async () => {
    const show = (await client.createShow(ADMIN, { name: 'S3', seats: ['A1', 'A2'], price_paise: 500 })).body;
    const token = await client.token('reuse-user');

    const first = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'reuse-key' });
    assert.equal(first.status, 201);

    const second = await client.reserve(token, show.id, { seats: ['A2'], idempotency_key: 'reuse-key' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'idempotency_key_reused');
  });

  await t.test('idempotency keys are per-user: two users sharing a key are independent', async () => {
    const show = (await client.createShow(ADMIN, { name: 'S4', seats: ['A1', 'A2'], price_paise: 500 })).body;
    const alice = await client.token('alice-idem');
    const bob = await client.token('bob-idem');

    const a = await client.reserve(alice, show.id, { seats: ['A1'], idempotency_key: 'shared-key' });
    const b = await client.reserve(bob, show.id, { seats: ['A2'], idempotency_key: 'shared-key' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.reservation_id, b.body.reservation_id);
  });

  await t.test('a declined attempt is not stored: retrying the same key re-evaluates fresh', async () => {
    const show = (await client.createShow(ADMIN, { name: 'S5', seats: ['A1'], price_paise: 500 })).body;
    const winner = await client.token('winner-user');
    const loser = await client.token('loser-user');

    const win = await client.reserve(winner, show.id, { seats: ['A1'], idempotency_key: 'w' });
    assert.equal(win.status, 201);

    const decline = await client.reserve(loser, show.id, { seats: ['A1'], idempotency_key: 'retry-key' });
    assert.equal(decline.status, 409);
    assert.equal(decline.body.error, 'seat_unavailable');

    // Free the seat, then retry with the SAME idempotency key - must succeed fresh, not replay a decline.
    await client.cancel(winner, win.body.reservation_id);
    const retry = await client.reserve(loser, show.id, { seats: ['A1'], idempotency_key: 'retry-key' });
    assert.equal(retry.status, 201);
  });
});
