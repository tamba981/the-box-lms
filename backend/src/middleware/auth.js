'use strict';

const User = require('../models/User');
const { forbidden, unauthorized } = require('../lib/errors');
const { verifyAccessToken } = require('../services/tokenService');

/**
 * Authentication and authorisation.
 *
 * Note what this middleware does NOT do: it never trusts a role from the token
 * alone for anything that matters. The token carries a role for cheap routing,
 * but the authoritative role is read from the database on every request, so
 * demoting or suspending a user takes effect immediately rather than when their
 * 15-minute token happens to expire.
 */

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;

  return value.trim();
}

/**
 * Require a valid access token and a live, active account.
 * Attaches `req.user` (a Mongoose document) and `req.auth` (token claims).
 */
async function authenticate(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) throw unauthorized('Please sign in to continue.', { code: 'NO_TOKEN' });

    const claims = verifyAccessToken(token);
    const user = await User.findById(claims.sub);

    if (!user) throw unauthorized('This account no longer exists.', { code: 'ACCOUNT_MISSING' });
    if (user.status !== 'active') throw unauthorized('This account has been suspended.', { code: 'ACCOUNT_INACTIVE' });

    // A password change invalidates tokens minted before it. `iat` is in
    // seconds; allow a 5-second clock skew so an immediate re-login is not
    // rejected on a slow request.
    if (user.passwordChangedAt && claims.iat * 1000 < user.passwordChangedAt.getTime() - 5000) {
      throw unauthorized('Your password was changed. Please sign in again.', { code: 'PASSWORD_CHANGED' });
    }

    req.user = user;
    req.auth = { claims, token };
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Attach `req.user` when a token is present and valid, but never reject. */
function optionalAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) return next();

  return authenticate(req, res, (error) => {
    // A bad token on a public route is treated as "anonymous", not an error.
    if (error) {
      req.user = null;
      req.auth = null;
    }
    return next();
  });
}

/** Restrict a route to the given roles. Must run after `authenticate`. */
function requireRole(...roles) {
  const allowed = roles.flat();

  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(unauthorized('Please sign in to continue.', { code: 'NO_TOKEN' }));

    if (!allowed.includes(req.user.role)) {
      return next(forbidden('Your account does not have access to this area.', { code: 'ROLE_REQUIRED' }));
    }

    return next();
  };
}

const requireAdmin = requireRole('admin');
const requireInstructor = requireRole('instructor', 'admin');

/** Admin, or the owner of the record. */
function requireSelfOrAdmin(getOwnerId) {
  return function requireSelfOrAdminMiddleware(req, res, next) {
    if (!req.user) return next(unauthorized('Please sign in to continue.', { code: 'NO_TOKEN' }));

    const ownerId = getOwnerId(req);
    if (req.user.role === 'admin' || (ownerId && String(ownerId) === String(req.user._id))) return next();

    return next(forbidden('You can only modify your own records.', { code: 'NOT_OWNER' }));
  };
}

module.exports = {
  authenticate,
  optionalAuth,
  requireRole,
  requireAdmin,
  requireInstructor,
  requireSelfOrAdmin,
  extractBearerToken,
};
