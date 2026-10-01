'use strict';

// Exercises the load-shedding path for real: an outside transaction holds the
// seat's row lock longer than lock_timeout, so the reserve transaction can never
// get it. The service must answer 429 (retryable, never 5xx), must NOT claim the
// seat is taken, must write nothing, and a retry with the same key must succeed
// once the lock is released.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { setupTestDb } = require('./helpers/testDb');
const { startTestApp } = require('./helpers/testApp');
const { makeClient } = require('./helpers/client');

const ADMIN = 'dev-admin-token';

test('overload: lock contention past lock_timeout sheds load as 429, writes nothing', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl);
  const client = makeClient(server.baseUrl);
  const blocker = new Client({ connectionString: db.databaseUrl });
  await blocker.connect();

  t.after(async () => {
    await blocker.end().catch(() => {});
    await server.close();
    await db.teardown();
  });

  const show = (await client.createShow(ADMIN, { name: 'Overload', seats: ['A1', 'A2'], price_paise: 100 })).body;
  const token = await client.token('shed-user');

  // Hold A1's row lock without changing it: the pre-check still sees it free,
  // so the request goes into the transaction and waits on the lock.
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM seats WHERE show_id = $1 AND label = $2 FOR UPDATE', [show.id, 'A1']);

  const r = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'shed-1' });
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.error, 'busy');
  assert.equal(r.headers.get('retry-after'), '1');

  // Nothing was written: no reservation row for the key, seat still available.
  const rows = await blocker.query('SELECT count(*)::int AS n FROM reservations WHERE idempotency_key = $1', ['shed-1']);
  assert.equal(rows.rows[0].n, 0);
  await blocker.query('ROLLBACK');

  const snap = await client.getShow(show.id);
  assert.equal(snap.body.counts.available, 2);
  assert.equal(snap.body.invariant_ok, true);

  // The client's retry with the same key now succeeds exactly once.
  const retry = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'shed-1' });
  assert.equal(retry.status, 201);
  const replay = await client.reserve(token, show.id, { seats: ['A1'], idempotency_key: 'shed-1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reservation_id, retry.body.reservation_id);

  const metricsText = await (await fetch(`${server.baseUrl}/metrics`)).text();
  assert.match(metricsText, /reservations_declined_total\{reason="overloaded"\} 1/);
});

// Regression: the replay branch inside the reserve transaction used to fetch the
// original reservation via a SECOND pool connection while still holding the first.
// With a small pool and a flood of same-key retries every connection ended up held
// by a request waiting for one more, freezing until the 60s pool timeout.
test('overload: same-key flood on a tiny pool cannot self-deadlock the pool', async (t) => {
  const db = await setupTestDb();
  const server = await startTestApp(db.databaseUrl, { poolMax: 3 });
  const client = makeClient(server.baseUrl);

  t.after(async () => {
    await server.close();
    await db.teardown();
  });

  const show = (await client.createShow(ADMIN, { name: 'Flood', seats: ['A1', 'A2', 'A3'], price_paise: 100 })).body;
  const token = await client.token('flood-user');

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 60 }, () => client.reserve(token, show.id, { seats: ['A2'], idempotency_key: 'flood-1' }))
  );
  const elapsed = Date.now() - started;

  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 200).length, 59, `statuses: ${statuses}`);
  assert.ok(elapsed < 10000, `took ${elapsed}ms — pool stalled`);
  assert.equal(new Set(results.map((r) => r.body.reservation_id)).size, 1);
});
