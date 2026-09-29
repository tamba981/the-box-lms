'use strict';

const jwt = require('jsonwebtoken');

const config = require('../config/env');
const logger = require('../lib/logger');
const Token = require('../models/Token');
const { unauthorized } = require('../lib/errors');

/**
 * All credential issuing and checking lives here.
 *
 * Access tokens are stateless JWTs with a short life (15 minutes by default).
 * Refresh tokens are opaque random strings whose hash is stored, so they can
 * be revoked, rotated, and — most importantly — replayed-detected.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Access tokens
 * ------------------------------------------------------------------ */

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
      email: user.email,
      typ: 'access',
    },
    config.jwt.accessSecret,
    {
      expiresIn: config.jwt.accessTtl,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }
  );
}

/**
 * @returns {{ sub: string, role: string, iat: number, exp: number }}
 * @throws AppError 401 for anything invalid, expired, or of the wrong type
 */
function verifyAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') throw unauthorized('Your session has expired. Please sign in again.', { code: 'TOKEN_EXPIRED' });
    throw unauthorized('Invalid authentication token.', { code: 'INVALID_TOKEN' });
  }

  // A refresh token must never be accepted as an access token.
  if (payload.typ !== 'access') throw unauthorized('Invalid authentication token.', { code: 'INVALID_TOKEN' });

  return payload;
}

/* ------------------------------------------------------------------ *
 * Refresh tokens
 * ------------------------------------------------------------------ */

function refreshExpiry() {
  return new Date(Date.now() + config.jwt.refreshTtlDays * MS_PER_DAY);
}

function metaFrom(req) {
  return {
    userAgent: req?.headers?.['user-agent']?.slice(0, 400) || null,
    ip: req?.ip || null,
  };
}

/**
 * Issue a refresh token. Tokens issued together share a `family`, which is the
 * unit of revocation if reuse is ever detected.
 */
async function issueRefreshToken(user, req, family) {
  const { raw, hash } = Token.generate();

  await Token.create({
    user: user._id,
    type: 'refresh',
    tokenHash: hash,
    family: family || Token.newFamily(),
    expiresAt: refreshExpiry(),
    ...metaFrom(req),
  });

  return raw;
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Reuse detection: a token that has already been rotated or revoked and is
 * presented again means the token leaked. We then revoke the entire family,
 * which signs out both the legitimate user and whoever stole the token.
 */
async function rotateRefreshToken(rawToken, req) {
  if (!rawToken) throw unauthorized('No refresh token provided.', { code: 'NO_REFRESH_TOKEN' });

  const hash = Token.hash(rawToken);
  const stored = await Token.findOne({ tokenHash: hash, type: 'refresh' });

  if (!stored) throw unauthorized('Invalid refresh token.', { code: 'INVALID_REFRESH_TOKEN' });

  if (stored.revokedAt || stored.usedAt) {
    logger.warn('refresh token reuse detected — revoking family', {
      userId: String(stored.user),
      family: stored.family,
    });

    await Token.updateMany(
      { family: stored.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    throw unauthorized('Your session is no longer valid. Please sign in again.', { code: 'SESSION_REVOKED' });
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Your session has expired. Please sign in again.', { code: 'REFRESH_EXPIRED' });
  }

  // The user must still exist and still be allowed in.
  const User = require('../models/User');
  const user = await User.findById(stored.user).select('+password');

  if (!user) throw unauthorized('This account no longer exists.', { code: 'ACCOUNT_MISSING' });
  if (user.status !== 'active') throw unauthorized('This account is not active.', { code: 'ACCOUNT_INACTIVE' });

  const { raw: nextRaw, hash: nextHash } = Token.generate();

  stored.usedAt = new Date();
  stored.replacedByHash = nextHash;
  await stored.save();

  await Token.create({
    user: user._id,
    type: 'refresh',
    tokenHash: nextHash,
    family: stored.family,
    expiresAt: refreshExpiry(),
    ...metaFrom(req),
  });

  return {
    user,
    accessToken: signAccessToken(user),
    refreshToken: nextRaw,
  };
}

/** Revoke a single refresh token (sign-out on one device). */
async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;

  await Token.updateOne(
    { tokenHash: Token.hash(rawToken), type: 'refresh', revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

/** Revoke every session for a user (sign-out everywhere, or after a password change). */
async function revokeAllSessions(userId) {
  const result = await Token.updateMany(
    { user: userId, type: 'refresh', revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );

  return result.modifiedCount;
}

/* ------------------------------------------------------------------ *
 * Single-use tokens: password reset and email verification
 * ------------------------------------------------------------------ */

async function createOneTimeToken(user, type, ttlMs) {
  // A new request invalidates any previous outstanding link, so an old email
  // cannot be replayed after the user asks for another one.
  await Token.updateMany({ user: user._id, type, usedAt: null }, { $set: { revokedAt: new Date() } });

  const { raw, hash } = Token.generate();

  await Token.create({
    user: user._id,
    type,
    tokenHash: hash,
    family: Token.newFamily(),
    expiresAt: new Date(Date.now() + ttlMs),
  });

  return raw;
}

const createPasswordResetToken = (user) => createOneTimeToken(user, 'reset', 60 * 60 * 1000);
const createEmailVerificationToken = (user) => createOneTimeToken(user, 'verify', 24 * 60 * 60 * 1000);

/**
 * Atomically consume a single-use token. The `findOneAndUpdate` filter includes
 * `usedAt: null`, so two concurrent submissions of the same link can never both
 * succeed — the database picks exactly one winner.
 */
async function consumeOneTimeToken(rawToken, type) {
  if (!rawToken) throw unauthorized('This link is not valid.', { code: 'INVALID_LINK' });

  const stored = await Token.findOneAndUpdate(
    {
      tokenHash: Token.hash(rawToken),
      type,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true }
  );

  if (!stored) throw unauthorized('This link is invalid or has expired. Please request a new one.', { code: 'LINK_EXPIRED' });

  return stored;
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  createPasswordResetToken,
  createEmailVerificationToken,
  consumeOneTimeToken,
  metaFrom,
};
