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

const { MAX_VIDEO_BYTES } = require('../lib/constants');

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
    'CORS_ORIGINS is not set. Same-origin requests are still accepted, because the guard ' +
      'compares the Origin header against the host the request arrived on. List a host here ' +
      'only if a separate frontend origin needs to call this API.'
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
 * Mobile money — Orange Money Liberia and Lonestar Cell MTN MoMo
 * ------------------------------------------------------------------ */

/**
 * Both providers are described the same way, so the registry can report
 * availability uniformly and checkout can treat them alike.
 *
 * `configured` requires all four values, and `missing` names the ones absent.
 * That is deliberate: "not configured" is useless to whoever has to configure
 * it, whereas "ORANGE_MONEY_API_KEY is not set" is actionable.
 *
 * Note there is no card provider in this list. Stripe — the implementation in
 * paymentService.js — is not available to businesses registered in Liberia, so a
 * card gateway has to be chosen separately. See docs/PAYMENTS.md.
 */
function describeMobileMoneyProvider({ id, label, prefix, currency, hint }) {
  const baseUrl = process.env[`${prefix}_BASE_URL`] || '';
  const merchantId = process.env[`${prefix}_MERCHANT_ID`] || '';
  const apiKey = process.env[`${prefix}_API_KEY`] || '';
  const callbackSecret = process.env[`${prefix}_CALLBACK_SECRET`] || '';

  const missing = [
    ['baseUrl', `${prefix}_BASE_URL`],
    ['merchantId', `${prefix}_MERCHANT_ID`],
    ['apiKey', `${prefix}_API_KEY`],
    ['callbackSecret', `${prefix}_CALLBACK_SECRET`],
  ]
    .filter(([key]) => !{ baseUrl, merchantId, apiKey, callbackSecret }[key])
    .map(([, name]) => name);

  return {
    id,
    label,
    kind: 'mobile_money',
    currency: (process.env[`${prefix}_CURRENCY`] || currency).toLowerCase(),
    phoneHint: hint,
    baseUrl,
    merchantId,
    apiKey,
    callbackSecret,
    configured: missing.length === 0,
    missing,
  };
}

const MOBILE_MONEY_PROVIDERS = [
  describeMobileMoneyProvider({
    id: 'orange_money',
    label: 'Orange Money',
    prefix: 'ORANGE_MONEY',
    currency: 'lrd',
    hint: 'Orange Liberia mobile number',
  }),
  describeMobileMoneyProvider({
    id: 'lonestar_momo',
    label: 'Lonestar Cell MTN MoMo',
    prefix: 'LONESTAR_MOMO',
    currency: 'lrd',
    hint: 'Lonestar Cell MTN mobile number',
  }),
];

/* ------------------------------------------------------------------ *
 * Object storage — lesson video and materials
 * ------------------------------------------------------------------ */

/**
 * Deliberately optional, and deliberately not `resolveSecret`.
 *
 * The platform works without object storage: an instructor can point a lesson at
 * a YouTube or Vimeo URL instead of uploading a file. So a production deployment
 * with no storage configured must still boot — refusing to start would take the
 * whole site down over a feature nobody is obliged to use.
 *
 * What is NOT acceptable is a half-configured bucket, or a placeholder secret,
 * because those fail at upload time with an opaque provider error. So the mode is
 * either fully configured or reported as missing by name.
 *
 * `missing` exists for the same reason the payment providers report it: "storage
 * is not configured" tells whoever has to fix it nothing, whereas
 * "STORAGE_BUCKET is not set" is actionable.
 */
const STORAGE_PROVIDER = String(process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
const STORAGE_BUCKET = String(process.env.STORAGE_BUCKET || '').trim();
const STORAGE_ENDPOINT = String(process.env.STORAGE_ENDPOINT || '').trim().replace(/\/+$/, '');
const STORAGE_ACCESS_KEY_ID = String(process.env.STORAGE_ACCESS_KEY_ID || '').trim();
const STORAGE_SECRET_ACCESS_KEY = String(process.env.STORAGE_SECRET_ACCESS_KEY || '').trim();
const STORAGE_REGION = String(process.env.STORAGE_REGION || 'auto').trim();

/**
 * R2 addresses buckets virtually-hosted, which is the SDK default. This exists
 * for S3-compatible providers that need path-style addressing instead.
 */
const STORAGE_FORCE_PATH_STYLE = String(process.env.STORAGE_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

const STORAGE_VIDEO_MAX_BYTES =
  Number.parseInt(process.env.STORAGE_VIDEO_MAX_BYTES, 10) || MAX_VIDEO_BYTES;
const STORAGE_URL_TTL_SECONDS = Number.parseInt(process.env.STORAGE_URL_TTL_SECONDS, 10) || 3600;

const STORAGE_MISSING = [
  ['STORAGE_PROVIDER', STORAGE_PROVIDER],
  ['STORAGE_BUCKET', STORAGE_BUCKET],
  ['STORAGE_ENDPOINT', STORAGE_ENDPOINT],
  ['STORAGE_ACCESS_KEY_ID', STORAGE_ACCESS_KEY_ID],
  ['STORAGE_SECRET_ACCESS_KEY', STORAGE_SECRET_ACCESS_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

const STORAGE_ENABLED = STORAGE_MISSING.length === 0;

// A secret that is present but weak is worse than an absent one: it looks set up.
if (STORAGE_SECRET_ACCESS_KEY && !isUsableSecret(STORAGE_SECRET_ACCESS_KEY)) {
  const message =
    'STORAGE_SECRET_ACCESS_KEY is set but is a placeholder, or shorter than 32 characters. ' +
    'Use the Secret Access Key from the R2 API token.';
  if (IS_PRODUCTION) fatal.push(message);
  else warnings.push(message);
}

if (!STORAGE_ENABLED && IS_PRODUCTION) {
  warnings.push(
    'Object storage is not configured. Instructors can still link to YouTube or Vimeo videos, ' +
      'but cannot upload video or material files. Missing: ' +
      STORAGE_MISSING.join(', ')
  );
}

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

  storage: {
    enabled: STORAGE_ENABLED,
    provider: STORAGE_PROVIDER,
    bucket: STORAGE_BUCKET,
    endpoint: STORAGE_ENDPOINT,
    region: STORAGE_REGION,
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
    videoMaxBytes: STORAGE_VIDEO_MAX_BYTES,
    urlTtlSeconds: STORAGE_URL_TTL_SECONDS,
    forcePathStyle: STORAGE_FORCE_PATH_STYLE,
    missing: STORAGE_MISSING,
  },

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

  mobileMoney: MOBILE_MONEY_PROVIDERS,

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
