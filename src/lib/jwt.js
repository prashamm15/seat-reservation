'use strict';

// Minimal HS256 JWT implementation using only node:crypto. No external JWT library.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payload, secret, { expiresInSeconds } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = Object.assign({ iat: nowSec }, payload);
  if (expiresInSeconds) {
    fullPayload.exp = nowSec + expiresInSeconds;
  }
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const sigB64 = base64url(signature);
  return `${signingInput}.${sigB64}`;
}

class JwtError extends Error {}

function verify(token, secret) {
  if (typeof token !== 'string' || !token) {
    throw new JwtError('malformed token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed token');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  let header;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch (e) {
    throw new JwtError('malformed header');
  }
  if (header.alg !== 'HS256') {
    throw new JwtError('unsupported alg');
  }

  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  let actualSig;
  try {
    actualSig = base64urlDecode(sigB64);
  } catch (e) {
    throw new JwtError('malformed signature');
  }
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    throw new JwtError('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch (e) {
    throw new JwtError('malformed payload');
  }

  if (typeof payload.exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= payload.exp) {
      throw new JwtError('token expired');
    }
  }

  return payload;
}

module.exports = { sign, verify, JwtError };
