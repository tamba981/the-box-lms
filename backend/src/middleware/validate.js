'use strict';

const { ZodError } = require('zod');

const { badRequest } = require('../lib/errors');

/**
 * Request validation.
 *
 * Every route declares the exact shape it accepts. This is not only about
 * friendly error messages — it is the primary injection defence: because each
 * field is declared as a concrete scalar (string, number, boolean, enum), an
 * object carrying Mongo operators (`{ $ne: null }`) is rejected before it can
 * reach a query.
 *
 * Parsed (and coerced) values are written to `req.valid.*`. The originals are
 * also replaced where the platform allows it, so handlers can keep reading
 * `req.body` as usual.
 */

function collectIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * @param {{ body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny }} schemas
 */
function validate(schemas = {}) {
  return function validateRequest(req, res, next) {
    req.valid = req.valid || { body: {}, query: {}, params: {} };

    try {
      if (schemas.params) {
        req.valid.params = schemas.params.parse(req.params);
        req.params = req.valid.params;
      }

      if (schemas.query) {
        req.valid.query = schemas.query.parse(req.query);
        // Express 5 makes `req.query` a read-only getter; assigning there would
        // throw. Handlers read `req.valid.query` so this stays optional.
        try {
          req.query = req.valid.query;
        } catch {
          /* read-only in this Express version — req.valid.query is authoritative */
        }
      }

      if (schemas.body) {
        req.valid.body = schemas.body.parse(req.body ?? {});
        req.body = req.valid.body;
      }

      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(
          badRequest('The submitted data is invalid.', {
            code: 'VALIDATION_ERROR',
            details: collectIssues(error),
          })
        );
      }
      return next(error);
    }
  };
}

module.exports = { validate };
