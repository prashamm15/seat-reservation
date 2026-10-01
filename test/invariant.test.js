'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = 'dev-admin-token';

test('invariant holds during and after a mixed concurrent burst', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  const seatLabels = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
  const show = (await client.createShow(ADMIN, { name: 'Invariant', seats: seatLabels, price_paise: 2500, per_user_limit: 4 })).body;

  const N = 120;
  const tokens = await Promise.all(Array.from({ length: N }, (_, i) => client.token(`inv-user-${i}`)));

  // Fire a burst of mixed single/double-seat, hold/confirm-immediate requests concurrently,
  // sampling the snapshot mid-flight to make sure the invariant never breaks even while busy.
  const midFlightCheck = (async () => {
    await new Promise((r) => setTimeout(r, 10));
    const snap = await client.getShow(show.id);
    assert.equal(snap.body.counts.available + snap.body.counts.held + snap.body.counts.confirmed, snap.body.counts.total);
  })();

  const requests = tokens.map((tok, i) => {
    const n = 1 + (i % 2);
    const seats = [];
    for (let k = 0; k < n; k++) {
      seats.push(seatLabels[(i + k) % seatLabels.length]);
    }
    const hold = i % 3 === 0;
    return client.reserve(tok, show.id, { seats: [...new Set(seats)], idempotency_key: `inv-${i}`, hold });
  });

  const results = await Promise.all([...requests, midFlightCheck]).then((arr) => arr.slice(0, -1));

  assert.equal(results.filter((r) => r.status >= 500).length, 0);

  const snap = await client.getShow(show.id);
  assert.equal(snap.body.counts.available + snap.body.counts.held + snap.body.counts.confirmed, snap.body.counts.total);
  assert.equal(snap.body.invariant_ok, true);
  assert.equal(snap.body.reconciliation.ok, true);
});
