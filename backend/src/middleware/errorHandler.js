'use strict';

const mongoose = require('mongoose');

const config = require('../config/env');
const logger = require('../lib/logger');
const { AppError } = require('../lib/errors');

/**
 * Terminal error handler.
 *
 * Anything that is not an AppError is an unexpected fault: it is logged with a
 * stack and reported to the client as a bare 500. Internal messages (and
 * anything a driver error might reveal about the schema) are never echoed back
 * in production.
 */

const MONGOOSE_DUPLICATE_KEY = 11000;

function isProd() {
  return config.isProduction;
}

// eslint-disable-next-line no-unused-vars -- Express identifies this as an error
// handler by its four-argument signature; `next` must stay in the list.
function errorHandler(error, req, res, next) {
  /* ---- Explicit application errors ------------------------------- */
  if (error instanceof AppError) {
    if (error.status >= 500) logger.error('request failed', { path: req.originalUrl, error });
    else logger.debug('request rejected', { path: req.originalUrl, status: error.status, msg: error.message });

    return res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code || undefined,
      details: error.details || undefined,
    });
  }

  /* ---- Mongoose schema validation -------------------------------- */
  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((fieldError) => ({
      field: fieldError.path,
      message: fieldError.message,
    }));

    return res.status(400).json({
      success: false,
      message: 'The submitted data is invalid.',
      code: 'VALIDATION_ERROR',
      details,
    });
  }

  /* ---- Malformed ObjectId in a path or filter -------------------- */
  if (error instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      success: false,
      message: `Invalid value for "${error.path}".`,
      code: 'INVALID_IDENTIFIER',
    });
  }

  /* ---- Unique index violation ------------------------------------ */
  if (error && error.code === MONGOOSE_DUPLICATE_KEY) {
    const field = Object.keys(error.keyPattern || {})[0] || 'value';
    return res.status(409).json({
      success: false,
      message: `That ${field} is already in use.`,
      code: 'DUPLICATE',
      details: [{ field, message: 'Already in use' }],
    });
  }

  /* ---- Body parser: malformed or oversized JSON ------------------- */
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Request body is not valid JSON.', code: 'BAD_JSON' });
  }

  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
  }

  /* ---- JWT library errors raised outside the auth middleware ------ */
  if (error && (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError')) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.', code: 'UNAUTHENTICATED' });
  }

  /* ---- Unexpected ------------------------------------------------ */
  logger.error('unhandled error', { path: req.originalUrl, method: req.method, error });

  return res.status(500).json({
    success: false,
    message: 'Something went wrong on our end. Please try again.',
    code: 'INTERNAL_ERROR',
    // Never expose internals in production; useful while developing.
    detail: isProd() ? undefined : error.message,
  });
}

/** Convert an unmatched route into a proper 404 through the handler above. */
function notFoundHandler(req, res, next) {
  const error = new AppError(404, `No endpoint matches ${req.method} ${req.originalUrl}.`, { code: 'NOT_FOUND' });
  next(error);
}

module.exports = { errorHandler, notFoundHandler };
