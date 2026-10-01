'use strict';

const jwt = require('./jwt');
const { safeCompare, extractBearerToken } = require('./util');
const { AppError } = require('../errors');

// Verified-token cache: a client reuses its token across many requests, so the HMAC
// check runs once per token, not once per request. Only successfully verified tokens
// are cached (keyed by the full token string, so a forged token can never hit), and
// expiry is still checked on every use.
const TOKEN_CACHE_MAX = 50000;
const tokenCache = new Map();

function verifyCached(token, secret) {
  const hit = tokenCache.get(token);
  if (hit && (typeof hit.exp !== 'number' || Math.floor(Date.now() / 1000) < hit.exp)) {
    return hit;
  }
  const payload = jwt.verify(token, secret);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(token, payload);
  return payload;
}

function requireUser(config) {
  return async function userAuthPreHandler(req) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new AppError(401, 'unauthorized', 'missing bearer token');
    }
    let payload;
    try {
      payload = verifyCached(token, config.jwtSecret);
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
