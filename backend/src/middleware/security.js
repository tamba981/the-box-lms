'use strict';

const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');

const config = require('../config/env');
const logger = require('../lib/logger');
const { forbidden } = require('../lib/errors');

/**
 * Security headers, CORS and compression.
 *
 * The pages and the API are served by the same Express process, so almost all
 * traffic is same-origin. Cross-origin access is therefore closed by default
 * and only opened for hosts named in CORS_ORIGINS.
 */

/**
 * Content Security Policy.
 *
 * `script-src` has to allow `'unsafe-inline'` because every page in this
 * project carries its own inline `<script>` block, and several of them are tens
 * of kilobytes of UI logic. Locking that down to `'self'` alone stops all of it
 * dead — the catalog never fetches, the dashboards never render.
 *
 * What is genuinely gained here is still worth having: no script may be loaded
 * from a third-party origin, `<base>` cannot be rewritten to redirect relative
 * URLs, plugins and framing are refused, and forms cannot post off-site. What
 * is not gained is protection against a script injected *into* the page.
 *
 * The path to removing `'unsafe-inline'` is to move each page's script into a
 * file under /assets/js and drop the inline block; that is a page-by-page
 * refactor, not a header change, and is deliberately left as follow-up work
 * rather than shipped half-done.
 */
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],

  'script-src': [
    "'self'",
    "'unsafe-inline'",
    // chart.js, loaded by the instructor and admin dashboards. Pulling a script
    // from a CDN is a supply-chain dependency, so the origin is named
    // explicitly rather than opening up https: wholesale. Self-hosting
    // chart.js in /assets/js would remove this line entirely and is the better
    // long-term arrangement.
    'https://cdn.jsdelivr.net',
  ],
  // Inline event handlers (`onclick=`, `onchange=`) are governed by
  // script-src-attr, which otherwise inherits script-src. There are around a
  // hundred of them across these pages, so this is stated explicitly rather
  // than left to the fallback.
  'script-src-attr': ["'unsafe-inline'"],

  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
  'img-src': ["'self'", 'data:', 'https:'],
  'media-src': ["'self'", 'https:'],
  'connect-src': ["'self'", ...config.allowedOrigins],

  'form-action': ["'self'"],
};

const contentSecurityPolicyOptions = {
  // Helmet 8 takes `{ useDefaults, directives }`. Passing the directives object
  // straight in is silently ignored — helmet does not error, it just uses its
  // own defaults, which include `script-src 'self'` and
  // `script-src-attr 'none'`. That combination blocks every inline script and
  // every inline handler on this site, and the only symptom is a console
  // violation and a page that never loads its data.
  useDefaults: false,
  directives: {
    ...CSP_DIRECTIVES,
    // Only meaningful over HTTPS, so it is omitted in local development where
    // it would try to upgrade http://localhost.
    ...(config.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
  },
};

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: config.isTest ? false : contentSecurityPolicyOptions,
    // The pages embed no third-party frames; the API returns no HTML.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Needed so Stripe can redirect back to the app from its hosted page.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
  });
}

/**
 * Reflect the caller's origin. Only ever reached for an origin that has already
 * been accepted below, so reflecting is safe and is what keeps credentialed
 * requests working for an allowlisted host.
 */
const reflectCors = cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 600,
});

function corsPolicy() {
  const allowed = new Set(config.allowedOrigins);

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    /**
     * Same-origin requests are accepted before the log line, not after it.
     *
     * The cors package's `origin` callback never sees the request, so it can
     * only consult the configured allowlist — which meant every ordinary POST
     * from this site's own pages was reported as a "blocked cross-origin
     * request" while succeeding. A log that cries wolf on normal traffic is
     * worse than no log, because it is where a real cross-origin attempt would
     * have to be noticed.
     */
    if (!origin || allowed.has(origin) || origin === requestOrigin(req)) {
      return reflectCors(req, res, next);
    }

    logger.warn('blocked cross-origin request', { origin, path: req.originalUrl });

    // Answer without the CORS headers, which the browser then refuses.
    return next();
  };
}

/**
 * The origin this request was actually addressed to, derived from the request.
 *
 * This is what makes "same-origin" true by construction rather than by
 * configuration. Browsers send an `Origin` header on every POST, PATCH and
 * DELETE — including same-origin ones — so a check that consults only the
 * configured allowlist rejects the site's own pages whenever CORS_ORIGINS is
 * empty. That is the default, and it made every sign-in a 403 while every GET
 * kept working, which is a confusing way for a deployment to fail.
 *
 * Behind a proxy this depends on `trust proxy` being set, so that req.protocol
 * reports the scheme the browser used (https) rather than the proxy's hop.
 */
function requestOrigin(req) {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * Reject state-changing requests whose Origin we do not recognise. Bearer
 * tokens are not sent automatically by the browser, so CSRF exposure is small —
 * this closes the remaining gap for the cookie-free case at negligible cost.
 */
function sameOriginGuard() {
  const allowed = new Set(config.allowedOrigins);

  return function guard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const origin = req.headers.origin;
    if (!origin) return next(); // curl, server-to-server, tests

    if (allowed.has(origin)) return next();

    // A request whose Origin matches the host it was sent to came from a page
    // this server is already serving. An attacker cannot satisfy this: forging
    // it requires already running on our origin.
    if (origin === requestOrigin(req)) return next();

    return next(forbidden('This request did not originate from a recognised host.', { code: 'CROSS_ORIGIN_BLOCKED' }));
  };
}

const compressionMiddleware = compression({
  // Never compress a compressed image or a video body we stream through.
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024,
});

module.exports = {
  securityHeaders,
  corsPolicy,
  sameOriginGuard,
  compressionMiddleware,
  CSP_DIRECTIVES,
  contentSecurityPolicyOptions,
};
