#!/usr/bin/env node
'use strict';

// Zero-dependency load/correctness burst tool. Uses only Node's global fetch.
//
// Usage:
//   node scripts/burst.js <BASE_URL> [--admin-token T] [--requests 20000]
//                          [--concurrency 1000] [--seats 2000] [--hot 5] [--storm 500]
//
// ADMIN_TOKEN may also come from the environment.

const REQUEST_TIMEOUT_MS = 60000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

// --- stats -----------------------------------------------------------------

function newStats() {
  return {
    total: 0,
    confirmed201: 0,
    replay200: 0,
    declinedByReason: {},
    other4xx: 0,
    serverErrors5xx: 0,
    networkErrors: 0,
    latencies: [],
  };
}

function recordResult(stats, res) {
  stats.total++;
  if (res.networkError) {
    stats.networkErrors++;
    return;
  }
  stats.latencies.push(res.ms);
  if (res.status === 201) {
    stats.confirmed201++;
  } else if (res.status === 200) {
    stats.replay200++;
  } else if (res.status === 409) {
    const code = (res.body && res.body.error) || 'unknown_409';
    stats.declinedByReason[code] = (stats.declinedByReason[code] || 0) + 1;
  } else if (res.status >= 500) {
    stats.serverErrors5xx++;
  } else if (res.status >= 400) {
    stats.other4xx++;
  }
}

// --- HTTP helpers ------------------------------------------------------------

async function httpJson(url, opts = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    const ms = Date.now() - start;
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (e) {
        body = text;
      }
    }
    return { status: res.status, body, headers: res.headers, ms };
  } catch (err) {
    clearTimeout(timer);
    return { networkError: true, error: err.message, ms: Date.now() - start };
  }
}

function authHeader(token) {
  return { authorization: `Bearer ${token}` };
}

async function reserve(baseUrl, token, showId, payload, extraHeaders = {}) {
  return httpJson(`${baseUrl}/shows/${showId}/reserve`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeader(token), extraHeaders),
    body: JSON.stringify(payload),
  });
}

async function cancel(baseUrl, token, reservationId) {
  return httpJson(`${baseUrl}/reservations/${reservationId}/cancel`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

async function getReservation(baseUrl, token, reservationId) {
  return httpJson(`${baseUrl}/reservations/${reservationId}`, { headers: authHeader(token) });
}

async function getShow(baseUrl, id) {
  return httpJson(`${baseUrl}/shows/${id}`);
}

// --- bounded concurrency pool -------------------------------------------------

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function workerLoop() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, workerLoop));
  return results;
}

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args._[0] || 'http://localhost:8080').replace(/\/$/, '');
  const adminToken = args['admin-token'] || process.env.ADMIN_TOKEN || 'dev-admin-token';
  const totalRequests = parseInt(args.requests || '20000', 10);
  const concurrency = parseInt(args.concurrency || '1000', 10);
  const seatCount = parseInt(args.seats || '2000', 10);
  const hotCount = parseInt(args.hot || '5', 10);
  const stormSize = parseInt(args.storm || '500', 10);

  console.log(`=== burst: ${baseUrl} requests=${totalRequests} concurrency=${concurrency} seats=${seatCount} hot=${hotCount} storm=${stormSize} ===`);

  const checks = []; // { name, pass, detail }
  function check(name, pass, detail) {
    checks.push({ name, pass, detail });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  }

  const globalStats = newStats();

  // 1. Readiness, retrying for cold starts.
  console.log('--- waiting for /readyz ---');
  const readyDeadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const r = await httpJson(`${baseUrl}/readyz`);
    if (r.status === 200) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  check('service became ready within 90s', ready);
  if (!ready) {
    console.error('Service never became ready. Aborting.');
    process.exit(1);
  }

  // 2. Create a fresh show.
  console.log('--- creating show ---');
  const seatLabels = Array.from({ length: seatCount }, (_, i) => `A${i + 1}`);
  const createRes = await httpJson(`${baseUrl}/shows`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeader(adminToken)),
    body: JSON.stringify({ name: `Burst Show ${Date.now()}`, seats: seatLabels, price_paise: 25000, per_user_limit: 4 }),
  });
  check('show created', createRes.status === 201, `status=${createRes.status}`);
  if (createRes.status !== 201) {
    console.error('Could not create show:', JSON.stringify(createRes.body));
    process.exit(1);
  }
  const show = createRes.body;
  console.log(`  show id = ${show.id}, seats = ${show.total_seats}`);

  // 3. Mint tokens.
  const userCount = Math.max(stormSize, 2000);
  console.log(`--- minting ${userCount} user tokens ---`);
  const userIds = Array.from({ length: userCount }, (_, i) => `burst-user-${i}`);
  const tokens = await runPool(userIds, 100, async (userId) => {
    const r = await httpJson(`${baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    return r.body && r.body.token;
  });
  check('tokens minted', tokens.every(Boolean), `${tokens.filter(Boolean).length}/${userCount}`);

  // Tracks reservation_id -> seats[] for every 201 we ever see, across every phase,
  // plus which of those reservations we successfully cancelled. Used for the final
  // "confirmed seat count == distinct 201'd seats - cancelled seats" check.
  const confirmedReservations = new Map(); // reservation_id -> seats[]
  const cancelledReservationIds = new Set();

  function noteReserveResult(res) {
    recordResult(globalStats, res);
    if (res.status === 201 && res.body && res.body.reservation_id) {
      confirmedReservations.set(res.body.reservation_id, res.body.seats);
    }
  }

  // --- Phase A: hot-seat storm -------------------------------------------------
  console.log(`--- phase A: hot-seat storm (${hotCount} seats x ${stormSize} users) ---`);
  const hotSeats = seatLabels.slice(0, hotCount);
  const hotWinners = {};
  {
    const tasks = [];
    for (const seat of hotSeats) {
      for (let u = 0; u < stormSize; u++) {
        tasks.push({ seat, userIdx: u });
      }
    }
    const results = await Promise.all(
      tasks.map(({ seat, userIdx }) =>
        reserve(baseUrl, tokens[userIdx % tokens.length], show.id, {
          seats: [seat],
          idempotency_key: `hot-${seat}-${userIdx}-${Date.now()}`,
        }).then((r) => ({ seat, userIdx, r }))
      )
    );
    for (const { seat, userIdx, r } of results) {
      noteReserveResult(r);
      if (r.status === 201) {
        hotWinners[seat] = hotWinners[seat] || [];
        hotWinners[seat].push(userIdx);
      }
    }
    for (const seat of hotSeats) {
      const winners = hotWinners[seat] || [];
      check(`hot seat ${seat} has exactly one winner`, winners.length === 1, `winners=${winners.length}`);
    }
  }

  // --- Phase B: stampede --------------------------------------------------------
  console.log(`--- phase B: stampede (${totalRequests} requests, concurrency ${concurrency}) ---`);
  {
    const skewCount = Math.max(1, Math.floor(seatCount * 0.1));
    function pickSeats(n) {
      const picked = [];
      for (let k = 0; k < n; k++) {
        let idx;
        if (Math.random() < 0.7) {
          idx = Math.floor(Math.random() * skewCount);
        } else {
          idx = Math.floor(Math.random() * seatCount);
        }
        picked.push(seatLabels[idx]);
      }
      return [...new Set(picked)];
    }

    const jobs = [];
    for (let i = 0; i < totalRequests; i++) {
      const userIdx = Math.floor(Math.random() * tokens.length);
      const token = tokens[userIdx];
      const nSeats = 1 + Math.floor(Math.random() * 2);
      const seats = pickSeats(nSeats);
      const key = `stampede-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const roll = Math.random();

      if (roll < 0.1) {
        // Fire the same key+body twice, concurrently.
        jobs.push(async () => {
          const payload = { seats, idempotency_key: key };
          const [a, b] = await Promise.all([reserve(baseUrl, token, show.id, payload), reserve(baseUrl, token, show.id, payload)]);
          noteReserveResult(a);
          noteReserveResult(b);
        });
      } else if (roll < 0.12) {
        // Reuse the key with different seats.
        jobs.push(async () => {
          const first = await reserve(baseUrl, token, show.id, { seats, idempotency_key: key });
          noteReserveResult(first);
          const altSeats = pickSeats(nSeats).length ? pickSeats(nSeats) : [seatLabels[0]];
          const second = await reserve(baseUrl, token, show.id, { seats: altSeats, idempotency_key: key });
          noteReserveResult(second);
        });
      } else {
        jobs.push(async () => {
          const r = await reserve(baseUrl, token, show.id, { seats, idempotency_key: key });
          noteReserveResult(r);
        });
      }
    }

    await runPool(jobs, concurrency, (job) => job());
  }

  // --- Phase C: per-user limit --------------------------------------------------
  console.log('--- phase C: per-user limit ---');
  {
    const limitUserToken = (await runPool(['burst-limit-user'], 1, async (userId) => {
      const r = await httpJson(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: `${userId}-${Date.now()}` }),
      });
      return r.body && r.body.token;
    }))[0];

    const snap = await getShow(baseUrl, show.id);
    const freeSeats = (snap.body.seats || []).filter((s) => s.status === 'available').slice(0, 10).map((s) => s.label);
    check('found 10 free seats for per-user-limit phase', freeSeats.length === 10, `found=${freeSeats.length}`);

    const results = await Promise.all(
      freeSeats.map((seat, i) =>
        reserve(baseUrl, limitUserToken, show.id, { seats: [seat], idempotency_key: `limit-${i}-${Date.now()}` })
      )
    );
    results.forEach(noteReserveResult);
    const succeeded = results.filter((r) => r.status === 201);
    check('per-user limit: at most 4 of 10 parallel reserves succeeded', succeeded.length <= 4, `succeeded=${succeeded.length}`);

    let allConfirmed = true;
    for (const r of succeeded) {
      const got = await getReservation(baseUrl, limitUserToken, r.body.reservation_id);
      if (got.status !== 200 || got.body.status !== 'confirmed') allConfirmed = false;
    }
    check('every successful per-user-limit reservation verifies as confirmed via GET', allConfirmed);
  }

  // --- Phase D: identity ---------------------------------------------------------
  console.log('--- phase D: identity ---');
  {
    const freshToken = async (name) => {
      const r = await httpJson(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: `${name}-${Date.now()}` }),
      });
      return r.body && r.body.token;
    };
    const tokenX = await freshToken('burst-identity-x');
    const tokenY = await freshToken('burst-identity-y');

    const snap = await getShow(baseUrl, show.id);
    const free = (snap.body.seats || []).filter((s) => s.status === 'available').map((s) => s.label);
    check('found at least 2 free seats for identity phase', free.length >= 2, `found=${free.length}`);
    const [seatX, seatY] = free;

    const xReserve = await reserve(baseUrl, tokenX, show.id, { seats: [seatX], idempotency_key: `identity-x-${Date.now()}` });
    noteReserveResult(xReserve);
    check('user X reserved a seat', xReserve.status === 201, `status=${xReserve.status}`);

    const spoofed = await reserve(baseUrl, tokenY, show.id, {
      seats: [seatY],
      idempotency_key: `identity-y-${Date.now()}`,
      user_id: 'burst-identity-x-should-be-ignored',
    });
    noteReserveResult(spoofed);
    check(
      'spoofed user_id in body is ignored - reservation belongs to the token holder (Y)',
      spoofed.status === 201 && spoofed.body.user_id !== 'burst-identity-x-should-be-ignored',
      `status=${spoofed.status} user_id=${spoofed.body && spoofed.body.user_id}`
    );

    const forbiddenCancel = await cancel(baseUrl, tokenY, xReserve.body.reservation_id);
    check('Y cannot cancel X\'s reservation (403)', forbiddenCancel.status === 403, `status=${forbiddenCancel.status}`);

    const ownCancel = await cancel(baseUrl, tokenX, xReserve.body.reservation_id);
    check('X can cancel their own reservation (200)', ownCancel.status === 200, `status=${ownCancel.status}`);
    if (ownCancel.status === 200) cancelledReservationIds.add(xReserve.body.reservation_id);

    const afterCancelSnap = await getShow(baseUrl, show.id);
    const seatXNow = (afterCancelSnap.body.seats || []).find((s) => s.label === seatX);
    check('cancelled seat shows available again', seatXNow && seatXNow.status === 'available', `status=${seatXNow && seatXNow.status}`);

    const rebook = await reserve(baseUrl, tokenY, show.id, { seats: [seatX], idempotency_key: `identity-rebook-${Date.now()}` });
    noteReserveResult(rebook);
    check('the freed seat is re-bookable by someone else', rebook.status === 201, `status=${rebook.status}`);
  }

  // --- Final: reconciliation + invariant -----------------------------------------
  console.log('--- final reconciliation ---');
  const finalSnap = await getShow(baseUrl, show.id);
  const counts = finalSnap.body.counts || {};
  check(
    'available + held + confirmed == total',
    counts.available + counts.held + counts.confirmed === counts.total,
    JSON.stringify(counts)
  );
  check('invariant_ok is true', finalSnap.body.invariant_ok === true);
  check('reconciliation.ok is true', finalSnap.body.reconciliation && finalSnap.body.reconciliation.ok === true, JSON.stringify(finalSnap.body.reconciliation));

  const expectedConfirmedSeats = new Set();
  for (const [resId, seats] of confirmedReservations.entries()) {
    if (cancelledReservationIds.has(resId)) continue;
    for (const s of seats) expectedConfirmedSeats.add(s);
  }
  check(
    'confirmed seat count matches distinct 201\'d seats minus cancelled seats',
    counts.confirmed === expectedConfirmedSeats.size,
    `actual=${counts.confirmed} expected=${expectedConfirmedSeats.size}`
  );

  // --- Metrics scrape --------------------------------------------------------------
  console.log('--- metrics scrape ---');
  const metricsRes = await httpJson(`${baseUrl}/metrics`);
  if (metricsRes.status === 200 && typeof metricsRes.body === 'string') {
    const interesting = [
      'reservations_confirmed_total',
      'reservations_declined_total',
      'reservations_cancelled_total',
      'holds_confirmed_total',
      'holds_expired_seats_total',
      'seats_confirmed_total',
      'http_5xx_total',
    ];
    const lines = metricsRes.body.split('\n').filter((l) => l && !l.startsWith('#') && interesting.some((m) => l.startsWith(m)));
    for (const l of lines) console.log('  ' + l);
  } else {
    console.log('  (could not scrape /metrics)');
  }

  // --- Summary table -----------------------------------------------------------------
  const sorted = [...globalStats.latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const max = sorted.length ? sorted[sorted.length - 1] : 0;

  console.log('\n=== SUMMARY ===');
  console.log(`total reserve requests observed : ${globalStats.total}`);
  console.log(`  201 confirmed/held            : ${globalStats.confirmed201}`);
  console.log(`  200 replay                    : ${globalStats.replay200}`);
  for (const [reason, count] of Object.entries(globalStats.declinedByReason)) {
    console.log(`  409 ${reason.padEnd(24)}     : ${count}`);
  }
  console.log(`  4xx other                     : ${globalStats.other4xx}`);
  console.log(`  5xx (MUST be 0)               : ${globalStats.serverErrors5xx}`);
  console.log(`  network errors/timeouts       : ${globalStats.networkErrors}`);
  console.log(`latency p50/p95/p99/max (ms)     : ${p50}/${p95}/${p99}/${max}`);
  console.log('\nhot seat winners:');
  for (const seat of hotSeats) {
    console.log(`  ${seat}: ${(hotWinners[seat] || []).length} winner(s)`);
  }

  console.log('\n=== CHECKS ===');
  let anyFail = false;
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    if (!c.pass) anyFail = true;
  }
  if (globalStats.serverErrors5xx > 0) {
    anyFail = true;
    console.log('  [FAIL] zero 5xx responses');
  } else {
    console.log('  [PASS] zero 5xx responses');
  }

  console.log(`\n${anyFail ? 'RESULT: FAIL' : 'RESULT: PASS'}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('burst script crashed:', err);
  process.exit(1);
});
