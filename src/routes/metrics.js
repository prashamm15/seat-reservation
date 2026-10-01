'use strict';

const metrics = require('../metrics');

async function metricsRoutes(app) {
  app.get('/metrics', async (req, reply) => {
    metrics.updatePoolGauges(app.pool);
    const body = await metrics.register.metrics();
    reply.header('Content-Type', metrics.register.contentType);
    return body;
  });
}

module.exports = metricsRoutes;
