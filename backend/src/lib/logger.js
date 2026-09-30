'use strict';

/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free: the MVP does not need a logging pipeline,
 * but it does need consistent, greppable output and a place to redact
 * sensitive fields before they reach stdout.
 */

const config = require('../config/env');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const ACTIVE_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? (config.isProduction ? LEVELS.info : LEVELS.debug);

/** Keys whose values must never be printed. */
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'apiKey',
  'secret',
  'stripeSecretKey',
]);

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: config.isProduction ? undefined : value.stack };
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(nested, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * A short, readable summary of an error, for the log message itself.
 *
 * Railway renders these JSON lines by their `msg` field, so a call like
 * `logger.error('failed to start', { error })` reached the deploy log as the
 * bare words "failed to start". The cause was sitting in `meta.error.message`
 * the entire time — recorded and invisible at once, which is worse than not
 * recording it, because it implies there is nothing further to learn. A crash
 * loop was diagnosed by guessing at an answer that was already in the log.
 *
 * Folding it into the message is done here, at the single point every log line
 * passes through, so that a future call site cannot reintroduce the problem by
 * forgetting. The stack is deliberately not included: this is for a human
 * reading a deployment log, and `meta` still carries the whole error.
 */
function summarise(value) {
  if (!value) return null;
  if (value instanceof Error) {
    const name = value.name && value.name !== 'Error' ? `${value.name}: ` : '';
    return `${name}${value.message}`;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.message === 'string') return value.message;
  return null;
}

function emit(level, message, meta) {
  if (LEVELS[level] > ACTIVE_LEVEL) return;

  const cause = meta ? summarise(meta.error) : null;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: cause ? `${message}: ${cause}` : message,
  };

  if (meta !== undefined) line.meta = redact(meta);

  const serialised = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialised}\n`);
  else process.stdout.write(`${serialised}\n`);
}

module.exports = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
  /** Whether a level would actually be printed, for expensive diagnostics. */
  enabled: (level) => LEVELS[level] <= ACTIVE_LEVEL,
  redact,
  summarise,
};
