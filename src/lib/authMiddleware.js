'use strict';

const jwt = require('./jwt');
const { safeCompare, extractBearerToken } = require('./util');
const { AppError } = require('../errors');

function requireUser(config) {
  return async function userAuthPreHandler(req) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new AppError(401, 'unauthorized', 'missing bearer token');
    }
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch (e) {
      throw new AppError(401, 'unauthorized', 'invalid or expired token');
    }
    if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
      throw new AppError(401, 'unauthorized', 'invalid token payload');
    }
    req.user = { sub: payload.sub };
  };
}

function requireAdmin(config) {
  return async function adminAuthPreHandler(req) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new AppError(401, 'unauthorized', 'missing bearer token');
    }
    if (!safeCompare(token, config.adminToken)) {
      throw new AppError(403, 'forbidden', 'invalid admin token');
    }
  };
}

module.exports = { requireUser, requireAdmin };
