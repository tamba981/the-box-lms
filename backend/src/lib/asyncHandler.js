'use strict';

/**
 * Wrap an async route handler so a rejected promise reaches the error
 * middleware instead of becoming an unhandled rejection. Without this, an
 * `await` that throws inside a handler leaves the request hanging.
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
