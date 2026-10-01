'use strict';

async function healthRoutes(app, { pool, state }) {
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  app.get('/readyz', async (req, reply) => {
    if (!state.migrated) {
      return reply.code(503).send({ status: 'not_ready', db: 'migrations not yet applied' });
    }
    try {
      const queryPromise = pool.query('SELECT 1');
      // Avoid an unhandled rejection if the 1s timeout wins the race and the
      // real query rejects later (e.g. a slow DNS failure against a bad host).
      queryPromise.catch(() => {});
      await Promise.race([
        queryPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db check timed out')), 1000)),
      ]);
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', db: err.message });
    }
  });
}

module.exports = healthRoutes;
