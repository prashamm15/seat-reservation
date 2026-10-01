'use strict';

const pino = require('pino');
const config = require('./config');

const MAX_LINES = 5000;
const ringBuffer = [];

const ringStream = {
  write(chunk) {
    const line = chunk.toString();
    ringBuffer.push(line);
    if (ringBuffer.length > MAX_LINES) {
      ringBuffer.shift();
    }
  },
};

const streams = [{ stream: process.stdout }, { stream: ringStream }];

const loggerInstance = pino(
  {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'authorization',
        '*.authorization',
        '*.Authorization',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.multistream(streams)
);

function getLogs({ requestId, limit, level } = {}) {
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_LINES);
  const out = [];
  // iterate from newest to oldest
  for (let i = ringBuffer.length - 1; i >= 0 && out.length < max; i--) {
    const raw = ringBuffer[i];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      continue;
    }
    if (requestId && parsed.reqId !== requestId && parsed.reqid !== requestId) continue;
    if (level && parsed.level !== levelNameToNumber(level)) continue;
    out.push(parsed);
  }
  return out.reverse();
}

function levelNameToNumber(name) {
  const map = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
  return map[String(name).toLowerCase()] ?? name;
}

module.exports = { loggerInstance, getLogs };
