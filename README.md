# Paytm Seat Reservation API

A JSON HTTP API that sells assigned seats for a show under heavy contention.
It never double-sells a seat, never exceeds a per-user limit, never double-books
a retried request, and keeps `available + held + confirmed == total_seats` true
at all times - even under a ~20,000 concurrent-request burst, where it returns
zero 5xx responses (declines are always 4xx).

Postgres is the single source of truth; all correctness decisions (seat
locking, idempotency, the per-user limit) happen inside Postgres transactions,
not in application memory. See [`WRITEUP.md`](./WRITEUP.md) for the design
rationale.

## Run locally (no Docker needed)

```bash
npm install
npm run dev
```

This boots an embedded Postgres instance under `.pgdata/` (gitignored, persists
between runs) and starts the server on `http://localhost:8080`. Ctrl+C shuts
both down cleanly.

## Run the tests

```bash
npm test
```

Runs the full `node --test` suite. Each test file boots its own throwaway
embedded Postgres on a free port (or reuses `DATABASE_URL` if you set one,
e.g. pointing at a real Postgres or the CI service container) and drives the
real app over real HTTP.

## Run with Docker

```bash
docker compose up --build
```

Starts a real `postgres:16-alpine` plus the app, wired together with a
healthcheck-gated `depends_on`. The API is on `http://localhost:8080`.

## Deploy to Render

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, pick the repo, and click
   **Apply**. `render.yaml` provisions a free Postgres database and a free
   Docker web service, wires `DATABASE_URL` from the database automatically,
   and generates `JWT_SECRET`/`ADMIN_TOKEN` for you.
3. Find the generated `ADMIN_TOKEN` in the Render dashboard under the web
   service's **Environment** tab once the blueprint has deployed.
4. **Live URL:** `https://<your-service>.onrender.com` - **TODO (candidate):
   fill in the actual deployed URL here.**

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DATABASE_URL` | - | required when `NODE_ENV=production` |
| `JWT_SECRET` | `dev-jwt-secret-change-me` | required in production |
| `ADMIN_TOKEN` | `dev-admin-token` | required in production; bearer token for `POST /shows` |
| `PG_POOL_MAX` | `20` | pg Pool size |
| `HOLD_TTL_SECONDS` | `120` | default hold TTL when a show doesn't override it |
| `DEFAULT_PER_USER_LIMIT` | `4` | default per-user seat limit when a show doesn't override it |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_SSL` | `false` | set `true` for hosts (Render/Neon) that need `ssl: {rejectUnauthorized:false}` |

## Auth

`POST /auth/token` is a **demo identity provider** - it mints a token for
whatever `user_id` you give it, with no password or verification. It stands
in for a real IdP (OAuth, magic link, SSO, etc.) that a production deployment
would put in front of this API instead. Every user endpoint requires
`Authorization: Bearer <jwt>`; the caller's identity is **always** the
token's `sub` claim - any `user_id` field in a request body is parsed but
never read for identity purposes.

The admin endpoint (`POST /shows`) requires `Authorization: Bearer <ADMIN_TOKEN>`
instead - a separate, fixed credential, not a user JWT.

## API reference

All request/response bodies are JSON. Money is always an integer number of
paise (never a float).

### `POST /auth/token`

```bash
curl -s localhost:8080/auth/token -H 'content-type: application/json' \
  -d '{"user_id":"alice"}'
# => {"token":"eyJ...","user_id":"alice"}
```

### `POST /shows` (admin)

```bash
curl -s localhost:8080/shows \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Hamilton","seats":["A1","A2","A3"],"price_paise":25000}'
```

`price_paise` must be a genuine JSON integer (a float or a numeric string is
rejected with 400). `per_user_limit` and `hold_ttl_seconds` are optional and
default to `DEFAULT_PER_USER_LIMIT`/`HOLD_TTL_SECONDS`.

### `GET /shows/:id` (public)

```bash
curl -s localhost:8080/shows/$SHOW_ID
curl -s "localhost:8080/shows/$SHOW_ID?include_seats=false"
```

Returns `counts`, `invariant_ok` (`available+held+confirmed==total`), and
`reconciliation` (seats currently held-or-confirmed vs. seats implied by
active reservation rows), all computed from one snapshot query. A seat whose
hold has lazily expired (`held_until <= now()`) is reported as `available`
even before the sweeper has gotten to it.

### `POST /shows/:id/reserve` (user)

```bash
curl -s localhost:8080/shows/$SHOW_ID/reserve \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seats":["A1","A2"],"idempotency_key":"order-123"}'
```

**All-or-nothing**: if any requested seat is unavailable, nothing is
reserved - you get `409 {"error":"seat_unavailable","unavailable":[...]}`
listing exactly which ones.

Add `"hold": true` to get a time-limited hold (`status: "held"`,
`expires_at` set) instead of an immediate confirm. The idempotency key can
also be sent as an `Idempotency-Key` header; if both are present they must
agree (400 if they don't).

**Replay**: firing the exact same `(seats, hold)` under the same key again
returns `200` (not `201`) with the original reservation and an
`Idempotent-Replayed: true` header - so a storm of retries against one hot
seat shows exactly one `201` total. Reusing the key with a *different* body
is `409 {"error":"idempotency_key_reused"}`. A **declined** attempt is never
stored, so retrying with the same key after a decline re-evaluates from
scratch rather than replaying the decline (see `WRITEUP.md`).

Under extreme overload (no DB connection or row lock obtainable in time) the
service sheds load with `429 {"error":"busy"}` + `Retry-After: 1`. Nothing was
written, so retry with the **same** idempotency key. It never answers 5xx for
contention, and never claims a seat is taken when it couldn't check.
If the database itself is unreachable, requests fail closed with
`503 {"error":"database_unavailable"}` + `Retry-After` (and `/readyz` is 503).

### `POST /reservations/:id/cancel` (owner only)

```bash
curl -s localhost:8080/reservations/$RES_ID/cancel -X POST -H "Authorization: Bearer $TOKEN"
```

Releases the seats back to `available` and marks the reservation
`cancelled`. `403` if you don't own it, `409 {"error":"not_active"}` if it's
already cancelled/expired.

### `POST /reservations/:id/confirm` (owner only)

Converts a still-valid hold to `confirmed`. `409 {"error":"hold_expired"}` if
the hold TTL already passed, `409 {"error":"not_held"}` if it was never a
hold (or already confirmed).

```bash
curl -s localhost:8080/shows/$SHOW_ID/reserve -X POST \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seats":["B1"],"idempotency_key":"hold-1","hold":true}'
# => {"reservation_id":"...","status":"held","expires_at":"..."}

curl -s localhost:8080/reservations/$RES_ID/confirm -X POST -H "Authorization: Bearer $TOKEN"
# => {"status":"confirmed", ...}
```

### `GET /reservations/:id` (owner only)

## Health, metrics, logs

- `GET /healthz` - liveness, always 200, never touches the DB.
- `GET /readyz` - readiness; fails closed with 503 until migrations have run
  **and** a real `SELECT 1` succeeds within 1s.
- `GET /metrics` - Prometheus text format (`prom-client`). Includes reservation
  outcome counters, HTTP request/duration histograms, pg pool gauges, and
  per-show seat-state gauges (for the 20 most recently created shows) computed
  at scrape time so they always reconcile with `GET /shows/:id`.
- `GET /logs?request_id=&limit=200&level=` - the last up-to-5000 structured
  log lines, kept in an in-memory ring buffer. This is the **public log
  access** for environments (like Render's free tier) where you can't tail
  the platform's own logs - every response also carries an `X-Request-Id`
  header you can filter this endpoint by.

## Burst / load script

```bash
# directly
node scripts/burst.js http://localhost:8080 --admin-token dev-admin-token

# via the wrapper
./burst.sh http://localhost:8080

# via npm
npm run burst -- http://localhost:8080 --admin-token dev-admin-token

# via make
make burst BASE_URL=http://localhost:8080
```

Flags: `--admin-token`, `--requests` (default 20000), `--concurrency`
(default 1000), `--seats` (default 2000), `--hot` (default 5), `--storm`
(default 500). `ADMIN_TOKEN` can also come from the environment.

It creates a fresh show, mints thousands of user tokens, then runs a
hot-seat storm, a mixed-traffic stampede (duplicate-concurrent retries and
key-reuse-with-different-seats included), a per-user-limit check, and an
identity-spoofing check, before re-reading the show and asserting the
invariant and reconciliation still hold. Prints a PASS/FAIL table with
latency percentiles and exits `1` on any failure or any 5xx.

## Project layout

```
src/
  app.js            Fastify app factory (routes, error handler, request logging)
  server.js         process entrypoint: pool, migrations, sweeper, listen
  db.js             pg Pool + migration runner (advisory-locked, retried in background)
  config.js         env var parsing/defaults
  metrics.js        prom-client registry and metric definitions
  logger.js         pino instance + in-memory ring buffer for /logs
  errors.js         AppError
  lib/
    jwt.js          HS256 JWT sign/verify on node:crypto only
    authMiddleware.js   requireUser / requireAdmin preHandlers
    retry.js        withRetry() for 40P01/40001/55P03 + isTransientInfraError()
    sweeper.js       expiry sweep (used by server.js's interval and directly in tests)
    serialize.js, util.js
  routes/
    auth.js, shows.js, reservations.js, health.js, metrics.js, logs.js
migrations/001_init.sql
scripts/
  dev.js            npm run dev: embedded Postgres + server, no Docker
  burst.js          the load/correctness burst tool
test/               node:test suite (real Postgres, real HTTP)
```
