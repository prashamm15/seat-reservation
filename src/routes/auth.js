'use strict';

const jwt = require('../lib/jwt');
const { AppError } = require('../errors');

const USER_ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Stands in for a real identity provider: any caller can mint a token for any
 * user_id. A production deployment would replace this with real auth (OAuth,
 * magic link, etc.) while keeping the same downstream JWT contract.
 */
async function authRoutes(app, { config }) {
  app.post('/auth/token', async (req) => {
    const body = req.body || {};
    const userId = body.user_id;
    if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
      throw new AppError(400, 'invalid_request', 'user_id must be 1-64 chars of [A-Za-z0-9_.@-]');
    }
    const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresInSeconds: DAY_SECONDS });
    return { token, user_id: userId };
  });
}

module.exports = authRoutes;
