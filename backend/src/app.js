'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');

const config = require('./config/env');
const db = require('./db');
const logger = require('./lib/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { securityHeaders, corsPolicy, sameOriginGuard, compressionMiddleware } = require('./middleware/security');
const { apiLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const coursesRoutes = require('./routes/courses');
const enrollmentsRoutes = require('./routes/enrollments');
const certificatesRoutes = require('./routes/certificates');
const notificationsRoutes = require('./routes/notifications');
const communityRoutes = require('./routes/community');
const messagesRoutes = require('./routes/messages');
const studyGroupsRoutes = require('./routes/studyGroups');
const liveSessionsRoutes = require('./routes/liveSessions');
const adminRoutes = require('./routes/admin');
const paymentsRoutes = require('./routes/payments');
const dashboardRoutes = require('./routes/dashboard');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'frontend', 'public');
const PUBLIC_DIR_EXISTS = fs.existsSync(PUBLIC_DIR);

/**
 * Assemble the Express application.
 *
 * Middleware order matters and is deliberate:
 *   1. request id, so every log line for one request is greppable
 *   2. security headers and CORS
 *   3. body parsing with a hard size limit
 *   4. same-origin guard for writes
 *   5. API routes, then static pages, then the 404 handler
 *   6. the error handler, last
 */
function createApp() {
  const app = express();

  // Railway (and any reverse proxy) terminates TLS and forwards the real
  // client address. Without this, `req.ip` is the proxy and rate limiting
  // would throttle every user together as a single client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /* ---- 1. Request id ------------------------------------------- */
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  /* ---- 2. Headers and CORS ------------------------------------- */
  app.use(securityHeaders());
  app.use(corsPolicy());

  /* ---- 3. Body parsing ---------------------------------------- */
  app.use(compressionMiddleware);

  /**
   * Stripe signs the exact bytes it sends, so its webhook must receive the raw
   * buffer rather than parsed JSON. Mounted before the JSON parser, which then
   * steps aside because `req._body` is already set for this path.
   */
  app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

// Mobile money callbacks are signed over the raw bytes for the same reason.
app.use('/api/v1/payments/callback', express.raw({ type: 'application/json', limit: '1mb' }));

  // 1 MB is generous for JSON here and caps a trivial memory-exhaustion attempt.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  /* ---- 4. Liveness -------------------------------------------- */
  // Deliberately before the same-origin guard and the rate limiter: a health
  // probe must always be answerable, from any host, as often as needed.
  app.get('/health', (req, res) => {
    const healthy = db.isConnected();
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      mongodb: db.state(),
      uptimeSeconds: Math.round(process.uptime()),
      version: require('../package.json').version,
    });
  });

  /* ---- 5. API -------------------------------------------------- */
  // The guard and the limiter are mounted once, at the root of the API, so an
  // endpoint cannot be added without them.
  app.use('/api/v1', sameOriginGuard(), apiLimiter);

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/courses', coursesRoutes);
  app.use('/api/v1/enrollments', enrollmentsRoutes);
  app.use('/api/v1/certificates', certificatesRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/community', communityRoutes);
  app.use('/api/v1/messages', messagesRoutes);
  app.use('/api/v1/study-groups', studyGroupsRoutes);
  app.use('/api/v1/live-sessions', liveSessionsRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/payments', paymentsRoutes);
  app.use('/api/v1/dashboard', dashboardRoutes);

  app.get('/api', (req, res) => {
    res.json({
      success: true,
      data: {
        name: 'Wuteve Global Academy API',
        version: require('../package.json').version,
        docs: `${config.publicBaseUrl}/api/v1`,
      },
    });
  });

  // Unmatched /api/* must answer with JSON, never with the HTML shell.
  app.use('/api', notFoundHandler);

  /* ---- 6. Static pages ---------------------------------------- */
  if (PUBLIC_DIR_EXISTS) {
    app.use(
      express.static(PUBLIC_DIR, {
        // `/login` resolves to login.html without a redirect.
        extensions: ['html'],
        index: 'index.html',
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
          // Pages must be revalidated so a deploy is picked up immediately;
          // images, fonts and stylesheets are content-stable and cached hard.
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
          }
        },
      })
    );

    // Friendly aliases for the pages, so links can be written without ".html".
    const aliases = {
      '/login': 'login.html',
      '/signup': 'login.html',
      '/register': 'login.html',
      '/signin': 'login.html',
      '/dashboard': 'student-dashboard.html',
      '/student': 'student-dashboard.html',
      '/instructor': 'instructor-dashboard.html',
      '/admin': 'admin-dashboard.html',
    };

    for (const [route, file] of Object.entries(aliases)) {
      app.get(route, (req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
    }

    /**
     * Pretty certificate URLs. The link in a certificate email and on the
     * document itself is `/verify/<code>`, which is a path with a variable
     * segment and so cannot be served by a static file alone. The page reads
     * the code back out of the URL and asks the API to verify it.
     */
    app.get('/verify/:code', (req, res) =>
      res.sendFile(path.join(PUBLIC_DIR, 'certificate.html'))
    );
  }

  /* ---- 7. Page 404 -------------------------------------------- */
  /**
   * A browser asking for an unknown page gets the real 404 document with a
   * genuine 404 status. Previously every unmatched path returned index.html
   * with a 200, which meant the site told search engines that every typo was
   * a valid page and the 404 page could never be reached at all.
   */
  app.use((req, res, next) => {
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    const notFoundPage = path.join(PUBLIC_DIR, '404.html');

    if (wantsHtml && PUBLIC_DIR_EXISTS && fs.existsSync(notFoundPage)) {
      return res.status(404).set('Cache-Control', 'no-store').sendFile(notFoundPage);
    }

    return next();
  });

  /* ---- 8. Errors ---------------------------------------------- */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
