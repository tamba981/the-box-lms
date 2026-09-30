'use strict';

/**
 * Process entry point.
 *
 * Responsibilities, in order: load and validate configuration (which exits the
 * process if anything is fatally wrong), connect to MongoDB, then — and only
 * then — start listening. The previous version started accepting traffic
 * immediately and reported itself healthy with no database at all.
 */

const fs = require('fs');
const path = require('path');

const config = require('./src/config/env');
const db = require('./src/db');
const logger = require('./src/lib/logger');
const { createApp, PUBLIC_DIR } = require('./src/app');

let server = null;

async function start() {
  logger.info('starting', { env: config.env, port: config.port });

  await db.connect();

  const app = createApp();

  /**
   * Say where the pages are, or that they are not there at all.
   *
   * Worth its own log line because of how this failure presents: when the
   * static directory is missing the API still answers everything, so the
   * deployment looks like it is half-working. Every page URL, including `/`,
   * comes back as the API's JSON 404, which reads as a routing problem and is
   * not one. Naming the directory, whether it exists, what sits beside it, and
   * the working directory turns a deduction into a fact in the deploy log.
   */
  const repoRoot = path.join(__dirname, '..');
  const staticPresent = fs.existsSync(PUBLIC_DIR);

  logger.info('static pages', {
    cwd: process.cwd(),
    node: process.version,
    resolved: PUBLIC_DIR,
    present: staticPresent,
    contains: staticPresent ? fs.readdirSync(PUBLIC_DIR).slice(0, 5) : null,
    // What the builder actually shipped, which is the part that was wrong.
    beside: fs.existsSync(repoRoot) ? fs.readdirSync(repoRoot) : null,
  });

  server = app.listen(config.port, () => {
    logger.info('listening', {
      url: config.publicBaseUrl,
      origins: config.allowedOrigins,
      email: config.email.enabled ? 'configured' : 'not configured',
      stripe: config.stripe.enabled ? 'configured' : 'not configured',
    });
  });

  // A slow-loris connection must not tie up a socket forever, but a long
  // request must still be allowed to finish.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;

  return server;
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * close the database, then exit. On Railway this is what makes a redeploy
 * seamless rather than dropping whatever was mid-request.
 */
async function shutdown(signal) {
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out — exiting forcefully');
    process.exit(1);
  }, 15000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.disconnect();
    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('error during shutdown', { error });
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { error: reason instanceof Error ? reason : { reason } });
});

process.on('uncaughtException', (error) => {
  logger.error('uncaught exception — the process is now in an unknown state', { error });
  shutdown('uncaughtException');
});

/**
 * The one startup failure that is almost always the same two mistakes.
 *
 * Worth a little pattern matching: the alternative is a crash loop whose only
 * visible symptom from outside is a 502 from the edge, and whoever is reading
 * it cannot tell a rotated password from a URI that needs percent-encoding.
 * These are the two ways a connection string is normally wrong.
 */
function isCredentialRejection(error) {
  return /authentication failed|bad auth|not authorized|AuthenticationFailed/i.test(
    String((error && error.message) || '')
  );
}

start().catch((error) => {
  logger.error('failed to start', { error });

  if (isCredentialRejection(error)) {
    logger.error(
      'That is the database refusing the credentials in MONGODB_URI, not a network problem — ' +
        'the server was reached and it answered, which is why this failed in about a second ' +
        'rather than waiting out the ten-second selection timeout. The two usual causes: the ' +
        'Atlas password was rotated after this value was set, so the deployed copy is the old ' +
        'one; or the password contains one of @ : / ? # % & or a space and is not ' +
        'percent-encoded in the URI.'
    );
  }

  process.exit(1);
});
