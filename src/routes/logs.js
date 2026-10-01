'use strict';

const { getLogs } = require('../logger');

async function logsRoutes(app) {
  app.get('/logs', async (req) => {
    const { request_id: requestId, limit, level } = req.query || {};
    const lines = getLogs({ requestId, limit, level });
    return { count: lines.length, lines };
  });
}

module.exports = logsRoutes;
