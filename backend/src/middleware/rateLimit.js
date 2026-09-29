'use strict';

const rateLimit = require('express-rate-limit');

const config = require('../config/env');

/**
 * Rate limiting.
 *
 * The previous deployment had none, which made `/auth/login` an open invitation
 * to password guessing. Limits are disabled under test so the suite is not
 * throttled by its own assertions.
 */

const passthrough = (req, res, next) => next();

function makeLimiter({ windowMs, limit, message, keyGenerator, skipSuccessfulRequests }) {
  if (config.isTest) return passthrough;

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: Boolean(skipSuccessfulRequests),
    keyGenerator,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        message,
        code: 'RATE_LIMITED',
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });
}

const MINUTE = 60 * 1000;

/** Broad ceiling for the whole API surface. */
const apiLimiter = makeLimiter({
  windowMs: 15 * MINUTE,
  limit: 600,
  message: 'Too many requests. Please slow down and try again shortly.',
});

/**
 * Sign-in and sign-up. Attacker-facing, so tight — and successful requests are
 * not counted, so a legitimate user typing their password correctly is never
 * locked out by their own successful logins.
 */
const authLimiter = makeLimiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this address. Please wait 15 minutes and try again.',
});

/**
 * Anything that sends an email or touches a payment: keyed by email as well as
 * IP, so one abused account cannot exhaust the mail quota for everyone.
 */
const sensitiveLimiter = makeLimiter({
  windowMs: 60 * MINUTE,
  limit: 10,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    return `${req.ip}:${email}`;
  },
  message: 'Too many attempts for this account. Please try again later.',
});

/** Writes to the community and messaging surfaces. */
const writeLimiter = makeLimiter({
  windowMs: MINUTE,
  limit: 60,
  message: 'You are posting very quickly. Please wait a moment and try again.',
});

module.exports = { apiLimiter, authLimiter, sensitiveLimiter, writeLimiter };
