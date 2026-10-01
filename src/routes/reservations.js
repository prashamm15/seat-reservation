'use strict';

const { AppError } = require('../errors');
const { requireUser } = require('../lib/authMiddleware');
const { isValidUuid, canonicalRequestHash, toSafeInt } = require('../lib/util');
const { serializeReservation } = require('../lib/serialize');
const { withRetry, isTransientInfraError } = require('../lib/retry');
const metrics = require('../metrics');

const MAX_SEATS_PER_REQUEST = 10;

function validateSeatsArray(seats) {
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS_PER_REQUEST) {
    throw new AppError(400, 'invalid_request', `seats must be an array of 1..${MAX_SEATS_PER_REQUEST} strings`);
  }
  for (const s of seats) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new AppError(400, 'invalid_request', 'every seat must be a non-empty string');
    }
  }
  const unique = new Set(seats);
  if (unique.size !== seats.length) {
    throw new AppError(400, 'invalid_request', 'seats must not contain duplicates');
  }
  return [...unique].sort();
}

async function findReservationByIdemKey(pool, userId, idempotencyKey) {
  const res = await pool.query('SELECT * FROM reservations WHERE user_id = $1 AND idempotency_key = $2', [
    userId,
    idempotencyKey,
  ]);
  return res.rowCount ? res.rows[0] : null;
}

// Shows are immutable once created (no update endpoint), so the fields the reserve
// path needs (price, per-user limit, hold TTL) are cached in memory: one fewer DB
// round trip per request. Only hits are cached — a missing show is re-checked.
const SHOW_CACHE_MAX = 1000;
const showCache = new Map();

async function getShow(pool, showId) {
  const cached = showCache.get(showId);
  if (cached) return cached;
  const res = await pool.query(
    'SELECT id, price_paise, per_user_limit, hold_ttl_seconds FROM shows WHERE id = $1',
    [showId]
  );
  if (res.rowCount === 0) return null;
  if (showCache.size >= SHOW_CACHE_MAX) showCache.clear();
  showCache.set(showId, res.rows[0]);
  return res.rows[0];
}

function declinedMetric(reason) {
  metrics.reservationsDeclinedTotal.inc({ reason });
}

// Load shedding: the request could not get a DB connection / lock in time and
// nothing was written. 429 + Retry-After tells the client to retry the SAME
// idempotency key, which is safe by construction.
function sendBusy(reply, logDecision, err) {
  declinedMetric('overloaded');
  if (logDecision) logDecision('declined', 'overloaded', { err: err.message });
  reply.header('Retry-After', '1');
  return reply.code(429).send({ error: 'busy', message: 'system is under heavy load, retry with the same idempotency key' });
}

async function reservationRoutes(app, { config }) {
  const userAuth = requireUser(config);

  // ---------------------------------------------------------------------
  // POST /shows/:id/reserve
  // ---------------------------------------------------------------------
  app.post('/shows/:id/reserve', { preHandler: userAuth }, async (req, reply) => {
    const userId = req.user.sub;
    const showId = req.params.id;

    if (!isValidUuid(showId)) {
      throw new AppError(404, 'not_found', 'show not found');
    }

    const body = req.body || {};
    const headerKey = req.headers['idempotency-key'];
    const bodyKey = body.idempotency_key;
    if (headerKey && bodyKey && headerKey !== bodyKey) {
      throw new AppError(400, 'invalid_request', 'Idempotency-Key header and body idempotency_key disagree');
    }
    const idempotencyKey = bodyKey || headerKey;
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      declinedMetric('invalid_request');
      throw new AppError(400, 'invalid_request', 'idempotency_key is required (body or Idempotency-Key header)');
    }

    const sortedSeats = validateSeatsArray(body.seats);
    const hold = body.hold === true;
    const requestHash = canonicalRequestHash({ showId, seats: sortedSeats, hold });

    const show = await getShow(app.pool, showId);
    if (!show) {
      throw new AppError(404, 'not_found', 'show not found');
    }

    // One concise log line per request: the decision is attached to the request and
    // emitted with the access line in the onResponse hook (src/app.js).
    const logDecision = (outcome, reason, extra) => {
      req.decision = Object.assign({ user_id: userId, show_id: showId, outcome, reason, seats: sortedSeats }, extra);
    };

    // --- (b) fast path: seat availability AND the idempotency key, in ONE statement. ---
    // Both reads come from the same snapshot, and a reservation commits atomically with
    // its seats. So if the seats look taken because *this key's* original request won,
    // that reservation is visible in the very same snapshot and we replay it — a retry is
    // never misreported as seat_unavailable. If the key already exists we can answer
    // from it directly (replay or key-reuse 409) without opening a transaction at all.
    // Nothing here decides a positive outcome: all-free only means "go try the txn".
    const preCheck = await app.pool.query(
      `SELECT req.label,
              s.label IS NOT NULL AS known,
              (s.status = 'available' OR (s.status = 'held' AND s.held_until <= now())) AS free,
              (SELECT row_to_json(r) FROM (
                 SELECT id, show_id, user_id, seats, amount_paise, status, expires_at, created_at, updated_at, request_hash
                 FROM reservations WHERE user_id = $3 AND idempotency_key = $4) r) AS existing
       FROM unnest($2::text[]) AS req(label)
       LEFT JOIN seats s ON s.show_id = $1 AND s.label = req.label`,
      [showId, sortedSeats, userId, idempotencyKey]
    );
    const existingKey = preCheck.rows.length ? preCheck.rows[0].existing : null;
    if (existingKey) {
      return replayResponse(existingKey, requestHash, reply, logDecision);
    }
    const unknownLabels = preCheck.rows.filter((r) => !r.known).map((r) => r.label);
    const takenLabels = preCheck.rows.filter((r) => r.known && !r.free).map((r) => r.label);

    // Distinguish "doesn't exist" (400) from "exists but taken" (409) - a nonexistent
    // seat is a client mistake, not contention, and deserves a different status code.
    if (unknownLabels.length > 0) {
      declinedMetric('unknown_seat');
      logDecision('declined', 'unknown_seat', { unknown: unknownLabels });
      return reply.code(400).send({ error: 'unknown_seat', unknown: unknownLabels });
    }
    if (takenLabels.length > 0) {
      declinedMetric('seat_taken');
      logDecision('declined', 'seat_taken', { unavailable: takenLabels });
      return reply.code(409).send({ error: 'seat_unavailable', unavailable: takenLabels });
    }

    // --- (c)-(g) the atomic transaction, retried on transient PG errors. ---
    let outcome;
    try {
      outcome = await withRetry(async () => {
      const client = await app.pool.connect();
      try {
        await client.query('BEGIN');

        const amountPaise = (BigInt(show.price_paise) * BigInt(sortedSeats.length)).toString();

        const insertRes = await client.query(
          `INSERT INTO reservations (show_id, user_id, seats, amount_paise, status, idempotency_key, request_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, now(), now())
           ON CONFLICT (user_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [showId, userId, sortedSeats, amountPaise, idempotencyKey, requestHash]
        );

        if (insertRes.rowCount === 0) {
          await client.query('ROLLBACK');
          // Must reuse THIS connection. Asking app.pool for a second one while holding
          // this one self-deadlocks the pool under a burst (every connection held by a
          // request waiting for one more) — the root cause of the earlier 60s stalls.
          const existing = await findReservationByIdemKey(client, userId, idempotencyKey);
          return { type: 'replay', existing };
        }

        const reservation = insertRes.rows[0];

        // (e) serialize this user's concurrent requests for this show, then enforce the per-user limit.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [showId, userId]);

        const activeRes = await client.query(
          `SELECT count(*)::int AS cnt FROM seats
           WHERE show_id = $1 AND user_id = $2
             AND (status = 'confirmed' OR (status = 'held' AND held_until > now()))`,
          [showId, userId]
        );
        const currentActive = activeRes.rows[0].cnt;
        if (currentActive + sortedSeats.length > show.per_user_limit) {
          // ROLLBACK (not a status update) so the pending row this txn inserted never
          // persists - a declined attempt is not stored, and a retry with the same
          // idempotency key re-evaluates from scratch rather than replaying a decline.
          await client.query('ROLLBACK');
          return { type: 'per_user_limit', limit: show.per_user_limit, current: currentActive };
        }

        // (f) lock the requested seats in a deterministic order to avoid deadlocks.
        // "Free" is evaluated by Postgres against the DB clock (never the app clock), so the
        // app and DB can never disagree about whether a hold has expired.
        const lockRes = await client.query(
          `SELECT label, (status = 'available' OR (status = 'held' AND held_until <= now())) AS free
           FROM seats
           WHERE show_id = $1 AND label = ANY($2)
           ORDER BY label FOR UPDATE`,
          [showId, sortedSeats]
        );

        if (lockRes.rowCount < sortedSeats.length) {
          const known = new Set(lockRes.rows.map((r) => r.label));
          const unknown = sortedSeats.filter((s) => !known.has(s));
          await client.query('ROLLBACK');
          return { type: 'unknown_seat', unknown };
        }

        const notFree = lockRes.rows.filter((r) => !r.free);
        if (notFree.length > 0) {
          await client.query('ROLLBACK');
          return { type: 'seat_unavailable', unavailable: notFree.map((r) => r.label) };
        }

        // (g) claim the seats, guarded on effective status so a concurrent winner can never be overwritten.
        const finalStatus = hold ? 'held' : 'confirmed';
        let expiresAt = null;
        if (hold) {
          const expRes = await client.query('SELECT now() + make_interval(secs => $1) AS exp', [show.hold_ttl_seconds]);
          expiresAt = expRes.rows[0].exp;
        }

        const updateRes = await client.query(
          `UPDATE seats SET status = $3, user_id = $4, reservation_id = $5, held_until = $6, updated_at = now()
           WHERE show_id = $1 AND label = ANY($2) AND (status = 'available' OR (status = 'held' AND held_until <= now()))`,
          [showId, sortedSeats, finalStatus, userId, reservation.id, expiresAt]
        );

        if (updateRes.rowCount !== sortedSeats.length) {
          // Defensive: a concurrent writer slipped in despite the row locks. Should not happen in practice.
          await client.query('ROLLBACK');
          return { type: 'seat_unavailable', unavailable: sortedSeats };
        }

        const finalRes = await client.query(
          `UPDATE reservations SET status = $2, expires_at = $3, updated_at = now() WHERE id = $1 RETURNING *`,
          [reservation.id, finalStatus, expiresAt]
        );

        await client.query('COMMIT');
        return { type: 'created', reservation: finalRes.rows[0] };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      });
    } catch (err) {
      if (!isTransientInfraError(err)) throw err;
      // Every retry was exhausted against lock/connection contention, or the pool
      // could not hand out a connection in time. Nothing was written (the txn rolled
      // back), so this is load shedding, NOT a lost race: report it honestly as a
      // retryable 429 under its own metric reason instead of claiming the seat is
      // taken — the seat may well still be free, and seat_taken must stay truthful.
      return sendBusy(reply, logDecision, err);
    }

    if (outcome.type === 'replay') {
      if (!outcome.existing) {
        // Extremely unlikely race: the row vanished between INSERT ON CONFLICT and our re-select.
        throw new AppError(500, 'internal_error', 'failed to resolve concurrent reservation');
      }
      return replayResponse(outcome.existing, requestHash, reply, logDecision);
    }
    if (outcome.type === 'per_user_limit') {
      declinedMetric('per_user_limit');
      logDecision('declined', 'per_user_limit', { limit: outcome.limit, current: outcome.current });
      return reply.code(409).send({ error: 'per_user_limit', limit: outcome.limit, current: outcome.current });
    }
    if (outcome.type === 'unknown_seat') {
      declinedMetric('unknown_seat');
      logDecision('declined', 'unknown_seat', { unknown: outcome.unknown });
      return reply.code(400).send({ error: 'unknown_seat', unknown: outcome.unknown });
    }
    if (outcome.type === 'seat_unavailable') {
      declinedMetric('seat_taken');
      logDecision('declined', 'seat_taken', { unavailable: outcome.unavailable });
      return reply.code(409).send({ error: 'seat_unavailable', unavailable: outcome.unavailable });
    }

    // type === 'created'
    const reservation = outcome.reservation;
    metrics.reservationsConfirmedTotal.inc({ mode: reservation.status });
    if (reservation.status === 'confirmed') {
      metrics.seatsConfirmedTotal.inc(sortedSeats.length);
    }
    logDecision('created', null, { reservation_id: reservation.id, mode: reservation.status });
    reply.code(201);
    return serializeReservation(reservation);
  });

  function replayResponse(existing, requestHash, reply, logDecision) {
    if (existing.request_hash !== requestHash) {
      declinedMetric('idempotency_key_reused');
      if (logDecision) logDecision('declined', 'idempotency_key_reused', { reservation_id: existing.id });
      return reply
        .code(409)
        .send({ error: 'idempotency_key_reused', message: 'this idempotency key was already used with a different request' });
    }
    declinedMetric('idempotent_replay');
    if (logDecision) logDecision('replayed', 'idempotent_replay', { reservation_id: existing.id });
    reply.header('Idempotent-Replayed', 'true');
    reply.code(200);
    return serializeReservation(existing, { idempotent_replay: true });
  }

  // ---------------------------------------------------------------------
  // GET /reservations/:id
  // ---------------------------------------------------------------------
  app.get('/reservations/:id', { preHandler: userAuth }, async (req) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      throw new AppError(404, 'not_found', 'reservation not found');
    }
    const res = await app.pool.query('SELECT * FROM reservations WHERE id = $1', [id]);
    if (res.rowCount === 0) {
      throw new AppError(404, 'not_found', 'reservation not found');
    }
    const reservation = res.rows[0];
    if (reservation.user_id !== req.user.sub) {
      throw new AppError(403, 'forbidden', 'you do not own this reservation');
    }
    return serializeReservation(reservation);
  });

  // ---------------------------------------------------------------------
  // POST /reservations/:id/cancel
  // ---------------------------------------------------------------------
  app.post('/reservations/:id/cancel', { preHandler: userAuth }, async (req, reply) => {
    const { id } = req.params;
    const userId = req.user.sub;
    if (!isValidUuid(id)) {
      throw new AppError(404, 'not_found', 'reservation not found');
    }

    let outcome;
    try {
      outcome = await withRetry(async () => {
        const client = await app.pool.connect();
        try {
          await client.query('BEGIN');
          const resRes = await client.query(
            `SELECT *, (status = 'held' AND expires_at <= now()) AS hold_expired FROM reservations WHERE id = $1 FOR UPDATE`,
            [id]
          );
          if (resRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return { type: 'not_found' };
          }
          const reservation = resRes.rows[0];
          if (reservation.user_id !== userId) {
            await client.query('ROLLBACK');
            return { type: 'forbidden' };
          }

          if (reservation.status === 'cancelled' || reservation.status === 'expired') {
            await client.query('ROLLBACK');
            return { type: 'not_active', status: reservation.status };
          }

          if (reservation.hold_expired) {
            await client.query(`UPDATE reservations SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
            await client.query('COMMIT');
            return { type: 'not_active', status: 'expired' };
          }

          await client.query(
            `SELECT label FROM seats WHERE show_id = $1 AND label = ANY($2) AND reservation_id = $3 ORDER BY label FOR UPDATE`,
            [reservation.show_id, reservation.seats, reservation.id]
          );

          await client.query(
            `UPDATE seats SET status = 'available', user_id = NULL, reservation_id = NULL, held_until = NULL, updated_at = now()
             WHERE show_id = $1 AND reservation_id = $2 AND status IN ('held', 'confirmed')`,
            [reservation.show_id, reservation.id]
          );

          const updatedRes = await client.query(
            `UPDATE reservations SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
            [id]
          );

          await client.query('COMMIT');
          return { type: 'cancelled', reservation: updatedRes.rows[0] };
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    } catch (err) {
      if (!isTransientInfraError(err)) throw err;
      return sendBusy(reply, null, err);
    }

    if (outcome.type === 'not_found') {
      throw new AppError(404, 'not_found', 'reservation not found');
    }
    if (outcome.type === 'forbidden') {
      throw new AppError(403, 'forbidden', 'you do not own this reservation');
    }
    if (outcome.type === 'not_active') {
      return reply.code(409).send({ error: 'not_active', status: outcome.status });
    }

    metrics.reservationsCancelledTotal.inc();
    req.decision = { user_id: userId, reservation_id: id, outcome: 'cancelled' };
    return serializeReservation(outcome.reservation);
  });

  // ---------------------------------------------------------------------
  // POST /reservations/:id/confirm
  // ---------------------------------------------------------------------
  app.post('/reservations/:id/confirm', { preHandler: userAuth }, async (req, reply) => {
    const { id } = req.params;
    const userId = req.user.sub;
    if (!isValidUuid(id)) {
      throw new AppError(404, 'not_found', 'reservation not found');
    }

    let outcome;
    try {
      outcome = await withRetry(async () => {
        const client = await app.pool.connect();
        try {
          await client.query('BEGIN');
          const resRes = await client.query(
            `SELECT *, (status = 'held' AND expires_at <= now()) AS hold_expired FROM reservations WHERE id = $1 FOR UPDATE`,
            [id]
          );
          if (resRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return { type: 'not_found' };
          }
          const reservation = resRes.rows[0];
          if (reservation.user_id !== userId) {
            await client.query('ROLLBACK');
            return { type: 'forbidden' };
          }

          if (reservation.hold_expired) {
            await client.query(`UPDATE reservations SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
            await client.query('COMMIT');
            return { type: 'hold_expired' };
          }
          if (reservation.status !== 'held') {
            await client.query('ROLLBACK');
            return { type: 'not_held' };
          }

          await client.query(
            `SELECT label FROM seats WHERE show_id = $1 AND label = ANY($2) AND reservation_id = $3 ORDER BY label FOR UPDATE`,
            [reservation.show_id, reservation.seats, reservation.id]
          );

          const updateRes = await client.query(
            `UPDATE seats SET status = 'confirmed', held_until = NULL, updated_at = now()
             WHERE reservation_id = $1 AND status = 'held' AND held_until > now()`,
            [reservation.id]
          );

          if (updateRes.rowCount !== reservation.seats.length) {
            await client.query('ROLLBACK');
            return { type: 'hold_expired' };
          }

          const updatedRes = await client.query(
            `UPDATE reservations SET status = 'confirmed', updated_at = now() WHERE id = $1 RETURNING *`,
            [id]
          );

          await client.query('COMMIT');
          return { type: 'confirmed', reservation: updatedRes.rows[0] };
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    } catch (err) {
      if (!isTransientInfraError(err)) throw err;
      return sendBusy(reply, null, err);
    }

    if (outcome.type === 'not_found') {
      throw new AppError(404, 'not_found', 'reservation not found');
    }
    if (outcome.type === 'forbidden') {
      throw new AppError(403, 'forbidden', 'you do not own this reservation');
    }
    if (outcome.type === 'hold_expired') {
      return reply.code(409).send({ error: 'hold_expired', message: 'the hold on this reservation has expired' });
    }
    if (outcome.type === 'not_held') {
      return reply.code(409).send({ error: 'not_held', message: 'reservation is not an active hold' });
    }

    metrics.holdsConfirmedTotal.inc();
    metrics.seatsConfirmedTotal.inc(outcome.reservation.seats.length);
    req.decision = { user_id: userId, reservation_id: id, outcome: 'confirmed' };
    return serializeReservation(outcome.reservation);
  });
}

module.exports = reservationRoutes;
