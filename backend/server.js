'use strict';

/**
 * Process entry point.
 *
 * Responsibilities, in order: load and validate configuration (which exits the
 * process if anything is fatally wrong), connect to MongoDB, then — and only
 * then — start listening. The previous version started accepting traffic
 * immediately and reported itself healthy with no database at all.
 */

const config = require('./src/config/env');
const db = require('./src/db');
const logger = require('./src/lib/logger');
const { createApp } = require('./src/app');

let server = null;

async function start() {
  logger.info('starting', { env: config.env, port: config.port });

  await db.connect();

  const app = createApp();

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

start().catch((error) => {
  logger.error('failed to start', { error });
  process.exit(1);
});
