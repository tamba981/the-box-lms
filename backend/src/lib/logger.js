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

function emit(level, message, meta) {
  if (LEVELS[level] > ACTIVE_LEVEL) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
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
};
