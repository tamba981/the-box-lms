'use strict';

/**
 * Application error types.
 *
 * Every error that reaches the client goes through `errorHandler`. Anything
 * that is not an `AppError` is treated as an unexpected fault: logged in
 * full, reported to the client as a generic 500 with no internal detail.
 */

class AppError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} message  Message safe to show the user
   * @param {object} [options]
   * @param {string} [options.code]    Machine-readable code for the client
   * @param {Array}  [options.details] Field-level validation details
   * @param {Error}  [options.cause]   Underlying error, for logging only
   */
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = options.code || null;
    this.details = options.details || null;
    this.expose = true;
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace(this, AppError);
  }
}

const badRequest = (message = 'Bad request', options) => new AppError(400, message, options);
const unauthorized = (message = 'Authentication required', options) =>
  new AppError(401, message, { code: 'UNAUTHENTICATED', ...options });
const forbidden = (message = 'You do not have access to this resource', options) =>
  new AppError(403, message, { code: 'FORBIDDEN', ...options });
const notFound = (message = 'Resource not found', options) => new AppError(404, message, options);
const conflict = (message = 'Resource already exists', options) => new AppError(409, message, options);
const tooMany = (message = 'Too many requests', options) => new AppError(429, message, options);
const unavailable = (message = 'Service temporarily unavailable', options) =>
  new AppError(503, message, options);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  unavailable,
};
