'use strict';

const pino = require('pino');
const config = require('./config');

const MAX_LINES = 5000;
// Fixed-size circular buffer: O(1) per line (Array#shift on a 5000-entry array is O(n)).
const ringBuffer = new Array(MAX_LINES);
let ringNext = 0;
let ringCount = 0;

const ringStream = {
  write(chunk) {
    ringBuffer[ringNext] = chunk.toString();
    ringNext = (ringNext + 1) % MAX_LINES;
    if (ringCount < MAX_LINES) ringCount++;
  },
};

// Async stdout: sonic-boom coalesces lines written while a previous write is in flight
// into one syscall, instead of one blocking write per line. flushLogs() on shutdown.
const stdoutDest = pino.destination({ dest: 1, sync: false });
const streams = [{ stream: stdoutDest }, { stream: ringStream }];

function flushLogs() {
  try {
    stdoutDest.flushSync();
  } catch (e) {
    // nothing buffered / stream not ready - fine
  }
}

const loggerInstance = pino(
  {
    level: config.logLevel,
    redact: {
      // Request objects/headers are never logged; this is a backstop. Exact paths
      // only - wildcard redaction is evaluated on every log call.
      paths: ['req.headers.authorization', 'headers.authorization', 'authorization'],
      censor: '[REDACTED]',
    },
  },
  pino.multistream(streams)
);

function getLogs({ requestId, limit, level } = {}) {
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_LINES);
  const out = [];
  // iterate from newest to oldest
  for (let n = 0; n < ringCount && out.length < max; n++) {
    const raw = ringBuffer[(ringNext - 1 - n + MAX_LINES) % MAX_LINES];
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

module.exports = { loggerInstance, getLogs, flushLogs };
