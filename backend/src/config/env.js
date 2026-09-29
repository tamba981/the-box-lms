'use strict';

/**
 * Central environment configuration.
 *
 * Design rules:
 *  - Load .env from the backend root regardless of the process CWD.
 *  - In production, a missing or placeholder secret is a FATAL error: the
 *    process refuses to boot rather than silently signing tokens with a
 *    value that is already public in this repository.
 *  - In development we fall back to a deterministic, clearly-labelled dev
 *    secret so that restarting the dev server does not log everyone out.
 */

const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_TEST = NODE_ENV === 'test';

/** Secrets that are known to the public because they appear in source/tutorials. */
const PLACEHOLDER_SECRETS = new Set([
  'your-super-secret-key-min-32-chars-long',
  'your-secret-key',
  'secret',
  'changeme',
  'change-me',
  'test',
  'development',
  'password',
]);

const fatal = [];
const warnings = [];

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

function isUsableSecret(value) {
  return Boolean(value) && value.length >= 32 && !PLACEHOLDER_SECRETS.has(value);
}

/**
 * Resolve a signing secret.
 * Production: must be supplied and strong, otherwise we abort.
 * Development: derive a stable, dev-only value so sessions survive restarts.
 */
function resolveSecret(name, devFallbackSeed) {
  const value = process.env[name];

  if (isUsableSecret(value)) return value;

  if (IS_PRODUCTION) {
    if (!value) {
      fatal.push(
        `${name} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
      );
    } else if (PLACEHOLDER_SECRETS.has(value)) {
      fatal.push(
        `${name} is still the public placeholder value from the source code. Set a unique random value before deploying.`
      );
    } else {
      fatal.push(`${name} must be at least 32 characters long.`);
    }
    // Return a random throwaway so module initialisation can continue far
    // enough to log the real problem, then process.exit below.
    return crypto.randomBytes(48).toString('base64url');
  }

  warnings.push(
    `${name} is not set (or is a placeholder). Using a DEV-ONLY secret derived from "${devFallbackSeed}". Never rely on this in production.`
  );
  return crypto
    .createHmac('sha256', `wuteve-dev-only:${devFallbackSeed}`)
    .update(NODE_ENV)
    .digest('hex');
}

const JWT_ACCESS_SECRET = resolveSecret('JWT_ACCESS_SECRET', 'access');
const JWT_REFRESH_SECRET = resolveSecret('JWT_REFRESH_SECRET', 'refresh');

/* ------------------------------------------------------------------ *
 * Core
 * ------------------------------------------------------------------ */

const PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';

if (!MONGODB_URI) {
  fatal.push('MONGODB_URI is not set. Create backend/.env with a MongoDB connection string.');
}

/* ------------------------------------------------------------------ *
 * URLs and CORS
 * ------------------------------------------------------------------ */

/**
 * PUBLIC_BASE_URL is used for links inside emails (verification, password
 * reset) and Stripe redirect URLs. It must be the URL a user can actually
 * reach, so it never defaults to a production hostname we do not own.
 */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

/**
 * Comma-separated allowlist. Falls back to local development origins only —
 * never to "reflect whatever Origin the caller sent", which is what the
 * previous `cors({ origin: true })` configuration did.
 */
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const DEFAULT_DEV_ORIGINS = [
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const ALLOWED_ORIGINS = CORS_ORIGINS.length > 0
  ? CORS_ORIGINS
  : (IS_PRODUCTION ? [] : DEFAULT_DEV_ORIGINS);

if (IS_PRODUCTION && ALLOWED_ORIGINS.length === 0) {
  warnings.push(
    'CORS_ORIGINS is not set. Because all pages are served by this same server, the API will ' +
      'only accept same-origin requests. Set CORS_ORIGINS if a separate frontend host calls the API.'
  );
}

/* ------------------------------------------------------------------ *
 * Email (optional until you actually need to send mail)
 * ------------------------------------------------------------------ */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Wuteve Global Academy <onboarding@resend.dev>';
const EMAIL_ENABLED = Boolean(RESEND_API_KEY);

if (!EMAIL_ENABLED && IS_PRODUCTION) {
  warnings.push(
    'RESEND_API_KEY is not set. Verification and password-reset emails cannot be delivered; ' +
      'links will be written to the server log instead.'
  );
}

/* ------------------------------------------------------------------ *
 * Stripe (optional until you enable paid courses)
 * ------------------------------------------------------------------ */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_ENABLED = Boolean(STRIPE_SECRET_KEY);

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

const config = {
  env: NODE_ENV,
  isProduction: IS_PRODUCTION,
  isTest: IS_TEST,
  port: PORT,

  mongoUri: MONGODB_URI,

  jwt: {
    accessSecret: JWT_ACCESS_SECRET,
    refreshSecret: JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: Number.parseInt(process.env.JWT_REFRESH_TTL_DAYS, 10) || 30,
    issuer: 'wuteve-global-academy',
    audience: 'wuteve-api',
  },

  publicBaseUrl: PUBLIC_BASE_URL,
  allowedOrigins: ALLOWED_ORIGINS,

  email: {
    enabled: EMAIL_ENABLED,
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
  },

  stripe: {
    enabled: STRIPE_ENABLED,
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
  },

  bcryptRounds: IS_TEST ? 4 : 12,
};

if (fatal.length > 0) {
  // eslint-disable-next-line no-console
  console.error('\n[FATAL] Invalid configuration — refusing to start:\n');
  for (const problem of fatal) {
    // eslint-disable-next-line no-console
    console.error(`  • ${problem}`);
  }
  // eslint-disable-next-line no-console
  console.error('\nSee backend/.env.example for the full list of settings.\n');
  process.exit(1);
}

if (warnings.length > 0) {
  // eslint-disable-next-line no-console
  console.warn('\n[config] warnings:');
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`  • ${warning}`);
  }
  // eslint-disable-next-line no-console
  console.warn('');
}

module.exports = config;
