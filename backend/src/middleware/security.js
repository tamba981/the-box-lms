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

/**
 * The origins a browser upload may reach, given the configured storage endpoint.
 *
 * Empty when storage is not configured, so this cannot open anything in a
 * deployment that does not upload. Both the endpoint as written and its wildcard
 * subdomain form are returned: virtual-hosted bucket URLs live at
 * `<bucket>.<endpoint host>`, and CSP does not infer that from the parent.
 */
function storageOrigins() {
  const endpoint = config.storage && config.storage.endpoint;
  if (!endpoint) return [];

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    // A malformed endpoint is reported by the storage service when it is used.
    // Standing the CSP up on a guess is worse than leaving it closed.
    return [];
  }

  return [`${parsed.protocol}//${parsed.host}`, `${parsed.protocol}//*.${parsed.host}`];
}

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
    // Google Translate. The element is only requested when a visitor picks a
    // language, but the policy has to allow it before a click can succeed —
    // CSP is not consultable at runtime. `translate-pa` serves the language list
    // as a JSONP script, which is a script load and not a fetch.
    'https://translate.google.com',
    'https://translate.googleapis.com',
    'https://translate-pa.googleapis.com',
  ],
  // Inline event handlers (`onclick=`, `onchange=`) are governed by
  // script-src-attr, which otherwise inherits script-src. There are around a
  // hundred of them across these pages, so this is stated explicitly rather
  // than left to the fallback.
  'script-src-attr': ["'unsafe-inline'"],

  'style-src': [
    "'self'",
    "'unsafe-inline'",
    'https://fonts.googleapis.com',
    'https://cdnjs.cloudflare.com',
    // The Translate element injects its own stylesheet, served from gstatic
    // rather than from the translate hosts.
    'https://translate.googleapis.com',
    'https://www.gstatic.com',
  ],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
  'img-src': ["'self'", 'data:', 'https:'],
  // Lesson video is served from a signed object-storage URL, so https: stays.
  'media-src': ["'self'", 'https:'],
  /*
   * Lesson video may be embedded from YouTube or Vimeo.
   *
   * This directive has to exist: `frame-src` otherwise falls back to
   * `default-src 'self'`, and every embed is refused. The failure is a console
   * violation and an empty player, with nothing on the page to explain it — the
   * same shape of silent breakage as the helmet defaults described below.
   *
   * Origins are named rather than opening `https:` wholesale. The stored address
   * is already restricted to these hosts when it is saved; this is the second
   * half of that boundary, and the player builds the embed from the parsed video
   * id rather than dropping the stored address into a src attribute.
   */
  'frame-src': [
    "'self'",
    'https://www.youtube.com',
    'https://www.youtube-nocookie.com',
    'https://player.vimeo.com',
    // The Translate element keeps its own toolbar frame on this origin. It is
    // hidden by CSS, but a hidden frame is still a frame and is still blocked.
    'https://translate.google.com',
  ],
  'connect-src': [
    "'self'",
    ...config.allowedOrigins,
    // Google Translate fetches its static assets and the translation itself over
    // XHR from these hosts once a visitor asks for a language.
    'https://translate.googleapis.com',
    'https://translate.google.com',
    'https://translate-pa.googleapis.com',
    // An instructor's browser PUTs the video file straight to object storage at a
    // signed URL, and an applicant's browser does the same with a photograph. That
    // origin has to be reachable from the page, or the upload fails as an opaque
    // network error.
    //
    // The signed URL is the *bucket* host, not the endpoint in the configuration:
    // R2 and S3 both address a bucket as a subdomain, so an endpoint of
    // `https://<account>.r2.cloudflarestorage.com` produces
    // `https://<bucket>.<account>.r2.cloudflarestorage.com`. CSP matches hosts
    // exactly and does not treat a parent domain as covering its subdomains, so
    // naming the endpoint alone blocked every upload with nothing in the UI beyond
    // "could not reach storage". Both forms are named here.
    ...storageOrigins(),
  ],

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
 * Send `www.` traffic to the canonical host.
 *
 * `www` and the apex host serve the same pages, which is duplicate content and,
 * worse, splits a signed-in visitor's cookies across two origins. The redirect is
 * active only in production and only when PUBLIC_BASE_URL names the host to keep,
 * so local development on 127.0.0.1 is untouched.
 *
 * 308 rather than 301 for anything that is not a GET: it preserves the method
 * and the body, so a form posted to the alias still arrives.
 */
function canonicalHost() {
  let canonical = null;

  if (config.isProduction) {
    try {
      canonical = new URL(config.publicBaseUrl).hostname.toLowerCase();
    } catch (error) {
      canonical = null;
    }
  }

  return function canonicalHostMiddleware(req, res, next) {
    if (!canonical || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(canonical)) return next();

    const host = String(req.get('host') || '').split(':')[0].toLowerCase();
    if (host !== `www.${canonical}`) return next();

    const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    return res.redirect(status, `https://${canonical}${req.originalUrl}`);
  };
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
  canonicalHost,
  corsPolicy,
  sameOriginGuard,
  compressionMiddleware,
  CSP_DIRECTIVES,
  contentSecurityPolicyOptions,
};
