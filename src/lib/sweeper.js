'use strict';

/**
 * Releases seats whose hold has expired and marks their reservations expired.
 * Correctness never depends on this running: every read/write elsewhere treats
 * an expired hold as effectively free already. This only tidies the rows so
 * they don't look misleadingly "held" forever in listings.
 */
async function sweepOnce(pool) {
  const client = await pool.connect();
  try {
    const seatRes = await client.query(`
      UPDATE seats s SET status = 'available', user_id = NULL, reservation_id = NULL, held_until = NULL, updated_at = now()
      FROM (
        SELECT show_id, label
        FROM seats
        WHERE status = 'held' AND held_until <= now()
        ORDER BY show_id, label
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
      ) x
      WHERE s.show_id = x.show_id AND s.label = x.label AND s.status = 'held' AND s.held_until <= now()
    `);

    const resRes = await client.query(`
      UPDATE reservations
      SET status = 'expired', updated_at = now()
      WHERE status = 'held' AND expires_at <= now()
    `);

    return { seatsExpired: seatRes.rowCount, reservationsExpired: resRes.rowCount };
  } finally {
    client.release();
  }
}

/** Wraps sweepOnce so overlapping ticks (a slow sweep + a fast interval) never run concurrently. */
function createSweeperLoop(pool, { intervalMs = 2000, logger, metrics } = {}) {
  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await sweepOnce(pool);
      if (metrics && result.seatsExpired > 0) {
        metrics.holdsExpiredSeatsTotal.inc(result.seatsExpired);
      }
    } catch (err) {
      if (logger) logger.error({ err: err.message }, 'sweeper tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { sweepOnce, createSweeperLoop };
