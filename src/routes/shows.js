'use strict';

const { AppError } = require('../errors');
const { requireAdmin } = require('../lib/authMiddleware');
const { isValidUuid, toSafeInt } = require('../lib/util');

function validateCreateShowBody(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'body must be a JSON object');
  }
  const { name, seats, price_paise: pricePaise } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError(400, 'invalid_request', 'name must be a non-empty string');
  }

  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 20000) {
    throw new AppError(400, 'invalid_request', 'seats must be an array of 1..20000 labels');
  }
  for (const label of seats) {
    if (typeof label !== 'string' || label.length === 0) {
      throw new AppError(400, 'invalid_request', 'every seat label must be a non-empty string');
    }
  }
  const uniqueSeats = new Set(seats);
  if (uniqueSeats.size !== seats.length) {
    throw new AppError(400, 'invalid_request', 'seat labels must be unique');
  }

  // Must be a genuine JSON integer - reject floats and numeric strings alike.
  if (typeof pricePaise !== 'number' || !Number.isInteger(pricePaise) || pricePaise < 0) {
    throw new AppError(400, 'invalid_request', 'price_paise must be a non-negative integer (paise)');
  }

  let perUserLimit = body.per_user_limit;
  if (perUserLimit === undefined || perUserLimit === null) {
    perUserLimit = undefined;
  } else if (!Number.isInteger(perUserLimit) || perUserLimit <= 0) {
    throw new AppError(400, 'invalid_request', 'per_user_limit must be a positive integer');
  }

  let holdTtlSeconds = body.hold_ttl_seconds;
  if (holdTtlSeconds === undefined || holdTtlSeconds === null) {
    holdTtlSeconds = undefined;
  } else if (!Number.isInteger(holdTtlSeconds) || holdTtlSeconds <= 0) {
    throw new AppError(400, 'invalid_request', 'hold_ttl_seconds must be a positive integer');
  }

  return { name, seats, pricePaise, perUserLimit, holdTtlSeconds };
}

async function showsRoutes(app, { config }) {
  app.post('/shows', { preHandler: requireAdmin(config) }, async (req, reply) => {
    const { name, seats, pricePaise, perUserLimit, holdTtlSeconds } = validateCreateShowBody(req.body);
    const effectivePerUserLimit = perUserLimit ?? config.defaultPerUserLimit;
    const effectiveHoldTtl = holdTtlSeconds ?? config.holdTtlSeconds;

    const client = await app.pool.connect();
    try {
      await client.query('BEGIN');
      const showRes = await client.query(
        `INSERT INTO shows (name, price_paise, per_user_limit, hold_ttl_seconds, total_seats)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [name, pricePaise, effectivePerUserLimit, effectiveHoldTtl, seats.length]
      );
      const show = showRes.rows[0];

      await client.query(
        `INSERT INTO seats (show_id, label, status, updated_at)
         SELECT $1, label, 'available', now() FROM unnest($2::text[]) AS label`,
        [show.id, seats]
      );
      await client.query('COMMIT');

      reply.code(201);
      return {
        id: show.id,
        name: show.name,
        price_paise: toSafeInt(show.price_paise),
        per_user_limit: show.per_user_limit,
        hold_ttl_seconds: show.hold_ttl_seconds,
        total_seats: show.total_seats,
        counts: { available: seats.length, held: 0, confirmed: 0, total: seats.length },
        seats: [...seats].sort().map((label) => ({ label, status: 'available' })),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/shows/:id', async (req) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      throw new AppError(404, 'not_found', 'show not found');
    }

    const includeSeats = req.query.include_seats !== 'false';

    const statsRes = await app.pool.query(
      `WITH seat_stats AS (
         SELECT
           count(*) FILTER (WHERE status = 'available' OR (status = 'held' AND held_until <= now())) AS available,
           count(*) FILTER (WHERE status = 'held' AND held_until > now()) AS held,
           count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
           count(*) AS total
         FROM seats WHERE show_id = $1
       ),
       active_res AS (
         SELECT COALESCE(SUM(cardinality(seats)), 0)::bigint AS seats_in_active_reservations
         FROM reservations
         WHERE show_id = $1 AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))
       ),
       show_row AS (
         SELECT id, name, price_paise, per_user_limit, hold_ttl_seconds, total_seats
         FROM shows WHERE id = $1
       )
       SELECT show_row.*, seat_stats.available, seat_stats.held, seat_stats.confirmed, seat_stats.total,
              active_res.seats_in_active_reservations
       FROM show_row, seat_stats, active_res`,
      [id]
    );

    if (statsRes.rowCount === 0) {
      throw new AppError(404, 'not_found', 'show not found');
    }

    const row = statsRes.rows[0];
    const available = Number(row.available);
    const held = Number(row.held);
    const confirmed = Number(row.confirmed);
    const total = Number(row.total);
    const seatsHeldOrConfirmed = held + confirmed;
    const seatsInActiveReservations = Number(row.seats_in_active_reservations);

    const result = {
      id: row.id,
      name: row.name,
      price_paise: toSafeInt(row.price_paise),
      per_user_limit: row.per_user_limit,
      total_seats: row.total_seats,
      counts: { available, held, confirmed, total },
      invariant_ok: available + held + confirmed === total,
      reconciliation: {
        seats_held_or_confirmed: seatsHeldOrConfirmed,
        seats_in_active_reservations: seatsInActiveReservations,
        ok: seatsHeldOrConfirmed === seatsInActiveReservations,
      },
    };

    if (includeSeats) {
      const seatsRes = await app.pool.query(
        `SELECT label,
                CASE WHEN status = 'held' AND held_until <= now() THEN 'available' ELSE status END AS status
         FROM seats WHERE show_id = $1 ORDER BY label`,
        [id]
      );
      result.seats = seatsRes.rows;
    }

    return result;
  });
}

module.exports = showsRoutes;
