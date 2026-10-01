# WRITEUP

## The atomic decision

Three Postgres mechanisms, each solving one specific race, compose into the
reserve algorithm in `src/routes/reservations.js`:

1. **A unique constraint on `(user_id, idempotency_key)`** on `reservations`
   gives exactly-once semantics for free. `INSERT ... ON CONFLICT (user_id,
   idempotency_key) DO NOTHING RETURNING *` either creates the row (you're
   first) or returns nothing (someone else already has this key). Critically,
   if a *second* concurrent request with the same key is mid-transaction when
   this INSERT runs, the unique index makes it **block** until the first
   transaction commits or rolls back - there is no window where both could
   succeed. Once it unblocks, the conflict check tells it definitively
   whether to replay (committed) or insert fresh (rolled back, so nothing to
   conflict with).

2. **`pg_advisory_xact_lock(hashtext(show_id), hashtext(user_id))`** serializes
   one user's concurrent requests against one show, for exactly as long as
   the enclosing transaction holds it. This is what makes the per-user-limit
   check safe: without it, two concurrent requests from the same user could
   both read "current count = 2, limit = 4, 2 more seats each is fine" and
   both proceed, landing at 6. With the lock, the second request's count read
   waits for the first's transaction to finish (commit or rollback), so it
   always sees the up-to-date count.

3. **`SELECT ... WHERE show_id=$1 AND label = ANY($2) ORDER BY label FOR
   UPDATE`, followed by a conditional `UPDATE ... WHERE (status='available'
   OR (status='held' AND held_until<=now()))`** is what actually claims the
   seats. The `ORDER BY label` is not cosmetic: every code path that locks
   seats (reserve, cancel, confirm) locks them in the same deterministic
   label order, so two transactions wanting an overlapping set of seats can
   never deadlock on each other - one always acquires the full prefix the
   other is waiting on. The `FOR UPDATE` blocks a second transaction wanting
   the same row until the first commits or rolls back; **why this is still
   race-free under READ COMMITTED** (not a stronger isolation level) is
   Postgres's own EvalPlanQual mechanism: when a row you're about to touch
   was concurrently updated and committed by someone else, Postgres
   re-evaluates your `WHERE` clause against the *new* row version before
   proceeding, rather than silently using the stale snapshot. That's exactly
   why the UPDATE's guard checks *effective* status again rather than trusting
   the earlier `SELECT ... FOR UPDATE` read - the guard is the real gate, the
   `FOR UPDATE` just serializes the queue of transactions evaluating it. The
   `UPDATE`'s `rowCount` is asserted equal to the requested seat count as a
   second, defensive check - if it isn't, something claimed a seat despite
   the lock (shouldn't happen, but a silently-wrong confirm is worse than an
   extra check), and the transaction rolls back to a 409 instead of
   committing a partial claim.

All three transactions (reserve, cancel, confirm) retry up to 3 times with
small jitter on `40P01` (deadlock), `40001` (serialization failure), and
`55P03` (lock_not_available) - belt-and-suspenders on top of the
deterministic lock ordering, which should make deadlocks rare but not
provably impossible given advisory locks + row locks interleaving.

**Why the fast-path pre-check is advisory, and why its ordering matters.**
Before opening any transaction, one cheap query checks whether the requested
seats *look* free. If they don't, and this is actually a retry of a request
whose original has since committed, declining it outright would be wrong -
the caller needs to see their original result, not a confusing
`seat_unavailable`. So the check order is: **seats first, then the
idempotency-key lookup** - never the other way around. If it were reversed
(key lookup first), a *first-time* request that happens to collide on an
unlucky random key with... no, that's not the risk; the real risk is a
race between "request A's transaction commits" and "request A's retry
starts": if the retry checked seats and found them taken by someone else
entirely unrelated to A's own prior success, it must still find A's own
committed reservation via the idempotency lookup and replay it, not declare
`seat_unavailable` against A's own seats. Checking seats first and falling
through to the key lookup on *any* negative result (rather than only on an
exact-match negative) is what makes this always resolve to a replay when
one exists, regardless of why the seats look unavailable.

The pre-check also distinguishes a seat that doesn't exist at all from one
that exists but is taken (by fetching every requested label's row,
regardless of status, rather than just counting free ones) - the spec
defines separate `400 unknown_seat` and `409 seat_unavailable` responses for
these, and folding them into one free-count check would have made
`unknown_seat` unreachable in the normal flow, since a nonexistent seat can
never count as free. This is documented as a deliberate interpretation in
**Deviations** below.

## Idempotency

- Stored on `reservations.idempotency_key`, scoped **per user** via the
  `UNIQUE (user_id, idempotency_key)` constraint - two different users can
  reuse the same key string independently, verified by a dedicated test.
- **Exactly-once** comes from that unique index plus `ON CONFLICT ... DO
  NOTHING`, not from application-level locking - the race is closed inside
  Postgres before application code ever sees two "winners."
- Same key + same canonical body (`sha256({show_id, seats: sorted unique,
  hold})`) → `200` replay of the original reservation, `Idempotent-Replayed:
  true` header, `idempotent_replay: true` in the body.
- Same key + a *different* body → `409 {"error":"idempotency_key_reused"}`.
  The stored `request_hash` is what's compared, not a field-by-field diff.
- **Declined requests are not stored - stated as a deliberate tradeoff, not
  an oversight.** Every decline path (`seat_taken`, `per_user_limit`,
  `unknown_seat`) explicitly `ROLLBACK`s the transaction that inserted the
  `pending` row, rather than updating it to some terminal "declined" status
  and committing it. This means a client that retries the *same*
  idempotency key after a decline gets a fresh evaluation against current
  state, not a replayed decline - which is almost always what you want (the
  seat that was taken a second ago might be free now). The tradeoff: if a
  client is relying on idempotency keys specifically to detect "did my
  earlier attempt actually fail, or do I not know yet," a decline followed
  by a retry under the same key looks identical to a first attempt from the
  server's point of view. In practice this is the right default for a
  reservation API (the whole point of a quick retry after a decline is to
  try again against fresh state), but it's worth naming as a choice with
  more than one defensible answer.

## Holds & expiry

A seat's *effective* status is computed lazily everywhere it matters (the
reserve transaction's seat lock check, `GET /shows/:id`'s counts, the
per-user-limit count): `status='held' AND held_until<=now()` reads as
`available`. **Correctness never depends on the sweeper running** - it only
exists to tidy rows that would otherwise sit in a stale `held` state
forever in a listing, and `src/lib/sweeper.js`'s `sweepOnce()` is tested
directly, not just through the 2-second interval.

The seat-release guard that matters most: cancel's `UPDATE seats SET
status='available', ... WHERE show_id=$1 AND reservation_id=$2 AND status
IN ('held','confirmed')` is scoped by **`reservation_id`**, not just
`show_id + label`. This is what makes it impossible for a cancel (or a
confirm) to ever resurrect a seat that has moved on: if reservation R's hold
expired and the seat was resold to a different reservation R2, a late
`cancel(R)` can never match a seat whose `reservation_id` is now R2's - the
`WHERE` clause simply finds zero matching rows. Tested explicitly: the
original holder's `confirm` after expiry gets `409 hold_expired`, their
`cancel` gets `409 not_active`, and the seat stays confirmed to the new
owner throughout.

## Consistency vs. availability under a partition

This is a **CP** system by construction: a single Postgres primary is the
only source of truth, and every write-path decision (lock a seat, enforce
the limit, record a reservation) happens inside one of its transactions.
If the primary is unreachable, `/readyz` fails closed (503) and every write
endpoint fails too (the pool simply can't produce a connection) - the
system chooses to refuse requests over risking a double-sell, which is the
correct tradeoff for inventory with a hard physical limit (there is no sane
way to "heal" two people holding the same physical seat after the fact).

A real multi-region deployment would need either (a) a single-writer
topology with regional read replicas serving `GET /shows/:id` reads while
all writes still funnel to one primary (simplest, keeps every guarantee in
this writeup, costs write latency for far-away regions), or (b) sharding
shows across independent Postgres instances by `show_id` so no cross-region
transaction is ever needed for the pieces that must be atomic - seat
contention is already scoped to one show, so this shards cleanly; global
per-user limits across shards would need a separate design if they ever
needed to span shards. True multi-writer (e.g. a CRDT-based seat map)
was not pursued because "never double-sell a numbered seat" is exactly the
kind of invariant that multi-writer conflict resolution handles badly.

## Observability

**Metrics** (`/metrics`, Prometheus text): `reservations_confirmed_total{mode}`,
`reservations_declined_total{reason}` (seat_taken, per_user_limit,
idempotent_replay, idempotency_key_reused, unknown_seat, invalid_request),
`reservations_cancelled_total`, `holds_confirmed_total`,
`holds_expired_seats_total`, `seats_confirmed_total`,
`http_requests_total{method,route,status}` +
`http_request_duration_seconds`, `http_5xx_total`, `db_pool_total/idle/waiting`,
and per-show `show_seats{show_id,state}` / `show_seats_total{show_id}` gauges
(20 most recent shows, computed at scrape time so they can never drift from
what `GET /shows/:id` reports) plus Node's default process metrics.

**What pages at 2am**, roughly in priority order:
1. **Any 5xx at all** (`http_5xx_total` moving, or the burst script's own
   assertion failing) - this system is specified to never produce one; a
   single occurrence means either a real bug or the infra-error fallback in
   `src/lib/retry.js` is masking something that needs attention.
2. **`invariant_ok: false` or `reconciliation.ok: false`** on any show - this
   would mean the core guarantee (never double-sell) has actually been
   violated, or the two independent ways of counting "how many seats are
   spoken for" have diverged. Either is a correctness emergency, not a
   performance one.
3. **`/readyz` failing** for more than a few seconds - writes are failing
   closed right now.
4. **p99 latency** on `http_request_duration_seconds` for the reserve route
   climbing - usually means lock contention or pool exhaustion building up.
5. **`db_pool_waiting` sustained > 0** alongside `db_pool_idle: 0` - the pool
   is undersized for current load; see the tuning note below.
6. **A rising rate of `55P03`/`40001`/`40P01` retries** (not directly
   exported as its own metric today - a natural next addition) - an early
   warning of lock contention before it turns into `db_pool_waiting`.

**Structured JSON logs** (pino, stdout): one `access` line per request
(method, route, status, ms, reqId) instead of Fastify's noisy default
request/response pair, plus one `reservation_decision` line per
reserve/cancel/confirm outcome (reqId, user_id, show_id, outcome, reason,
seats, reservation_id). `Authorization` headers are redacted. `GET
/logs?request_id=&limit=&level=` serves the last 5000 lines from an
in-memory ring buffer - the documented **public log access** for a host
(like Render's free tier) where you can't otherwise tail the platform's own
logs; every response carries the `X-Request-Id` the logs endpoint can be
filtered by.

## Load characteristics & limits on free tier

Measured locally (one laptop, embedded Postgres, single Fastify process):
a 20,000-request burst at 1,000-way concurrency against a fresh 2,000-seat
show completes with **0 5xx, 0 network errors**, p50/p95/p99/max latency
around 300ms/1.2s/1.3s/1.4s (see the burst output in the final report for
the exact run). The first attempt at this scale *did* produce 5xx (pool
connections parking for up to a 10s `lock_timeout` under hot-row
contention, then the pool itself timing out handing out connections) -
fixed by dropping `lock_timeout` to 3s so losing transactions fail fast and
free their connection for the next attempt, plus a defensive fallback that
converts any retry-exhausted lock/connection-timeout error into a 409
decline rather than ever surfacing as 500 (see the dedicated commit for the
full story). On a free hosting tier (Render free web service: shared/0.1
CPU typically, free Postgres with a low connection cap, and a cold start
after idle) the same burst would need a materially lower `--concurrency`
and `--requests` to stay within the same latency envelope - `PG_POOL_MAX`
in particular should never be set higher than the free Postgres plan's own
`max_connections` allows headroom for (migrations, the sweeper, and any
manual `psql` all need a slot too).

## AI usage

This service was designed with Claude Opus 5.5 (architecture/atomicity
spec, code review, test verification) and implemented with Claude Sonnet
via Claude Code, at the candidate's direction.

> TODO (candidate): describe in your own words what you directed, what you
> changed or rejected, and what you verified yourself.

## Deviations from the spec, and why

- **The fast-path pre-check (step b) distinguishes "seat doesn't exist" from
  "seat exists but is taken"** by fetching every requested label's row
  (existence + effective-free status) instead of only counting free rows.
  The spec's literal wording ("one query counting requested seats that are
  effectively free... if fewer than n are free... 409 seat_unavailable")
  would make the transaction's own `400 unknown_seat` branch (step f)
  unreachable in practice, since a nonexistent seat can never contribute to
  a "free" count and the fast path would always decline first. Classifying
  unknown seats as `400` at the fast-path stage instead gives a more useful
  answer (the client made a mistake vs. the client lost a race) and
  actually exercises the error code the spec defines for it. This was
  caught by a test expecting `400 unknown_seat` for a wholly-unknown seat
  label and is the one place the implementation reads the algorithm's
  *intent* rather than its literal query shape.
- **`lock_timeout` is 3s and `statement_timeout` is 10s**, not the spec's
  example values of 10s/15s - see **Load characteristics** above. Tightening
  `lock_timeout` is what makes "zero 5xx under a ~20k burst" actually true
  on a pool sized at the spec's own default (`PG_POOL_MAX=20`) rather than
  only true at a smaller scale.
- **A defensive `isTransientInfraError` fallback** (in `src/lib/retry.js`,
  used by the reserve/cancel/confirm handlers and as a last resort in the
  global error handler) converts a retry-exhausted lock/serialization/
  statement-timeout error, or the pg pool failing to hand out a connection
  in time, into a `409` decline instead of a `500`. This isn't in the spec's
  algorithm description, but the spec's own hard requirement ("ZERO 5xx
  under a ~20,000 concurrent request burst") doesn't hold without it on
  real hardware under real contention - verified by the burst script, which
  found exactly this failure mode on the first full-scale run.
- **Docker/compose were not executed locally** - this environment doesn't
  have Docker installed. The Dockerfile, `docker-compose.yml`, and the CI
  workflow's docker job were written carefully against the spec (multi-stage
  not required, `npm ci --omit=dev`, non-root user, healthcheck-gated
  `depends_on`) but are unverified beyond review. `npm test` and the full
  20,000-request burst **were** run and verified directly against the
  locally-running app (embedded Postgres + `node src/server.js`), which
  exercises the identical application code the Docker image runs.

## What I'd do next

- A payment step modeled as a saga: reserve (hold) → charge → confirm, with
  a compensating cancel if the charge fails, instead of today's
  reserve-is-the-payment-boundary model.
- A Redis-backed read-through cache of each show's seat map for `GET
  /shows/:id` under heavy read fan-out (a popular on-sale show gets far more
  reads than writes) - would need a cache-invalidation story tied to the
  same transactions that mutate `seats`.
- Per-show sharding or a queue-based admission control in front of the
  hottest shows for 100k+ RPS - today's single-primary design is correct
  but a single Postgres instance has a ceiling, and the natural shard key
  (`show_id`) is already how contention is scoped.
- Rate limiting per user/IP on `/auth/token` and `/shows/:id/reserve` - the
  demo auth endpoint currently lets anyone mint unlimited tokens.
- k6 (or similar) soak tests across hours, not just a single burst, to catch
  slow leaks (connection pool, memory, the in-memory log ring buffer) that
  a short burst can't surface.
- OpenTelemetry tracing across the reserve transaction's internal steps
  (advisory lock wait, row lock wait, update) to make the "which step is
  slow" question answerable from a trace instead of inferred from logs.
- A dedicated metric for retry counts by Postgres error code (`40P01`/
  `40001`/`55P03`), called out above as a natural early-warning signal that
  isn't exported today.
