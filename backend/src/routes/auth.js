'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');

const Enrollment = require('../models/Enrollment');
const Notification = require('../models/Notification');
const Token = require('../models/Token');
const User = require('../models/User');
const email = require('../services/email');
const tokens = require('../services/tokenService');

const config = require('../config/env');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { conflict, unauthorized, badRequest } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate, extractBearerToken } = require('../middleware/auth');
const { authLimiter, sensitiveLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/auth');

const router = express.Router();

/**
 * A real, well-formed bcrypt hash compared against when no account exists, so
 * the sign-in response time does not reveal whether an email is registered.
 * Computed once, lazily, on the first such request.
 */
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('timing-equalisation-placeholder', config.bcryptRounds);
  return dummyHashPromise;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Every successful sign-in or sign-up returns the same payload. Centralised so
 * the three call sites cannot drift apart.
 */
async function issueSession(user, req, res, status = 200, message = 'OK') {
  const accessToken = tokens.signAccessToken(user);
  const refreshToken = await tokens.issueRefreshToken(user, req);

  const payload = {
    user: user.toPublicJSON({ includePrivate: true }),
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.jwt.accessTtl,
  };

  return status === 201 ? created(res, payload, message) : ok(res, payload, message);
}

/** Fire-and-forget email: a mail failure must never fail the request. */
function sendLater(describe, send) {
  setImmediate(async () => {
    try {
      const message = send();
      await email.deliver(message);
    } catch (error) {
      logger.error('failed to prepare email', { describe, error });
    }
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/register
 * ------------------------------------------------------------------ */

router.post(
  '/register',
  authLimiter,
  validate({ body: schemas.registerBody }),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email: address, password, phone } = req.valid.body;

    const existing = await User.findOne({ email: address }).select('_id');
    if (existing) {
      throw conflict('An account with that email address already exists. Try signing in instead.', {
        code: 'EMAIL_IN_USE',
        details: [{ field: 'email', message: 'Already registered' }],
      });
    }

    /**
     * Role is hard-coded. It is never read from the request — that was the
     * privilege-escalation hole in the previous API, where
     * `{"role":"admin"}` in the sign-up body produced an administrator.
     */
    const user = await User.create({
      firstName,
      lastName,
      email: address,
      password,
      phone: phone || undefined,
      role: 'student',
    });

    // Verification link, best effort.
    const verifyToken = await tokens.createEmailVerificationToken(user);
    const verifyUrl = `${config.publicBaseUrl}/verify-email.html?token=${encodeURIComponent(verifyToken)}`;
    sendLater('verification', () => email.verificationEmail({ user, url: verifyUrl }));

    return issueSession(user, req, res, 201, 'Your account has been created.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/login
 * ------------------------------------------------------------------ */

router.post(
  '/login',
  authLimiter,
  validate({ body: schemas.loginBody }),
  asyncHandler(async (req, res) => {
    const { email: address, password } = req.valid.body;

    // `+password` because the field is `select: false` by default.
    const user = await User.findOne({ email: address }).select('+password');

    /**
     * One generic message for both "no such account" and "wrong password", and
     * the bcrypt comparison always runs, so response time does not reveal
     * whether the address is registered.
     */
    const invalid = () => unauthorized('Email or password is incorrect.', { code: 'BAD_CREDENTIALS' });

    if (!user) {
      await bcrypt.compare(password, await dummyHash());
      throw invalid();
    }

    const matches = await user.comparePassword(password);
    if (!matches) throw invalid();

    if (user.status !== 'active') {
      throw unauthorized('This account has been suspended. Please contact support.', { code: 'ACCOUNT_INACTIVE' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    return issueSession(user, req, res, 200, 'Signed in successfully.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/refresh
 * ------------------------------------------------------------------ */

router.post(
  '/refresh',
  validate({ body: schemas.refreshBody }),
  asyncHandler(async (req, res) => {
    const rotated = await tokens.rotateRefreshToken(req.valid.body.refreshToken, req);

    return ok(
      res,
      {
        user: rotated.user.toPublicJSON({ includePrivate: true }),
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        tokenType: 'Bearer',
        expiresIn: config.jwt.accessTtl,
      },
      'Session refreshed.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/logout
 * ------------------------------------------------------------------ */

router.post(
  '/logout',
  validate({ body: schemas.logoutBody }),
  asyncHandler(async (req, res) => {
    if (req.valid.body.allDevices) {
      // Requires a valid access token, otherwise anyone holding a stolen
      // refresh token could sign the real owner out of everything.
      const bearer = extractBearerToken(req);
      if (!bearer) throw unauthorized('Please sign in to continue.', { code: 'NO_TOKEN' });

      const claims = tokens.verifyAccessToken(bearer);
      await tokens.revokeAllSessions(claims.sub);
      return noContent(res, 'Signed out of all devices.');
    }

    await tokens.revokeRefreshToken(req.valid.body.refreshToken);
    return noContent(res, 'Signed out.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/auth/me
 * ------------------------------------------------------------------ */

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const [enrollmentCount, unreadNotifications] = await Promise.all([
      Enrollment.countDocuments({ student: req.user._id, status: { $ne: 'cancelled' } }),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);

    return ok(res, {
      user: req.user.toPublicJSON({ includePrivate: true }),
      stats: { enrollmentCount, unreadNotifications },
    });
  })
);

/* ------------------------------------------------------------------ *
 * PATCH /api/v1/auth/me
 * ------------------------------------------------------------------ */

router.patch(
  '/me',
  authenticate,
  validate({ body: schemas.updateProfileBody }),
  asyncHandler(async (req, res) => {
    // Whitelisted assignments: `role`, `status` and `emailVerified` are not
    // reachable from this endpoint even if they appear in the body.
    const { firstName, lastName, phone, bio, avatarUrl, headline, expertise } = req.valid.body;

    if (firstName !== undefined) req.user.firstName = firstName;
    if (lastName !== undefined) req.user.lastName = lastName;
    if (phone !== undefined) req.user.phone = phone || null;
    if (bio !== undefined) req.user.bio = bio || null;
    if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl || null;
    if (headline !== undefined) req.user.headline = headline || null;
    if (expertise !== undefined) req.user.expertise = expertise;

    await req.user.save();

    return ok(res, { user: req.user.toPublicJSON({ includePrivate: true }) }, 'Profile updated.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/change-password
 * ------------------------------------------------------------------ */

router.post(
  '/change-password',
  authenticate,
  validate({ body: schemas.changePasswordBody }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;

    const user = await User.findById(req.user._id).select('+password');
    const matches = await user.comparePassword(currentPassword);
    if (!matches) {
      throw badRequest('Your current password is incorrect.', {
        code: 'BAD_CURRENT_PASSWORD',
        details: [{ field: 'currentPassword', message: 'Incorrect' }],
      });
    }

    if (await user.comparePassword(newPassword)) {
      throw badRequest('Choose a password you have not used before.', {
        code: 'PASSWORD_REUSED',
        details: [{ field: 'newPassword', message: 'Same as the current password' }],
      });
    }

    user.password = newPassword;
    // Invalidates every access token minted before this moment.
    user.passwordChangedAt = new Date();
    await user.save();

    // Changing a password ends every other session.
    await tokens.revokeAllSessions(user._id);

    sendLater('password-changed', () => email.passwordChangedEmail({ user }));

    // The caller's own refresh token was just revoked, so hand them a new one.
    const refreshToken = await tokens.issueRefreshToken(user, req);

    return ok(
      res,
      { accessToken: tokens.signAccessToken(user), refreshToken, user: user.toPublicJSON({ includePrivate: true }) },
      'Your password has been changed. Other devices have been signed out.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/forgot-password
 * ------------------------------------------------------------------ */

router.post(
  '/forgot-password',
  sensitiveLimiter,
  validate({ body: schemas.forgotPasswordBody }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.valid.body.email });

    /**
     * Always the same response, whether or not the address exists. Otherwise
     * this endpoint becomes a free account-enumeration oracle.
     */
    if (user && user.status === 'active') {
      const resetToken = await tokens.createPasswordResetToken(user);
      const url = `${config.publicBaseUrl}/reset-password.html?token=${encodeURIComponent(resetToken)}`;
      sendLater('password-reset', () => email.passwordResetEmail({ user, url }));
    }

    return ok(
      res,
      null,
      'If that email address has an account, a password reset link is on its way.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/reset-password
 * ------------------------------------------------------------------ */

router.post(
  '/reset-password',
  sensitiveLimiter,
  validate({ body: schemas.resetPasswordBody }),
  asyncHandler(async (req, res) => {
    const { token, password } = req.valid.body;

    // Consuming the token is atomic, so a replayed link cannot set a second
    // password even under concurrent requests.
    const stored = await tokens.consumeOneTimeToken(token, 'reset');

    const user = await User.findById(stored.user).select('+password');
    if (!user) throw unauthorized('This link is no longer valid.', { code: 'ACCOUNT_MISSING' });

    user.password = password;
    user.passwordChangedAt = new Date();
    await user.save();

    // A password reset must invalidate every existing session.
    await tokens.revokeAllSessions(user._id);

    sendLater('password-changed', () => email.passwordChangedEmail({ user }));

    return ok(res, null, 'Your password has been reset. You can now sign in.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/verify-email
 * ------------------------------------------------------------------ */

router.post(
  '/verify-email',
  validate({ body: schemas.verifyEmailBody }),
  asyncHandler(async (req, res) => {
    const stored = await tokens.consumeOneTimeToken(req.valid.body.token, 'verify');
    const user = await User.findById(stored.user);

    if (!user) throw unauthorized('This link is no longer valid.', { code: 'ACCOUNT_MISSING' });

    if (!user.emailVerified) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      await user.save();
      sendLater('welcome', () => email.welcomeEmail({ user }));
    }

    return ok(res, { user: user.toPublicJSON({ includePrivate: true }) }, 'Your email address is confirmed.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/auth/resend-verification
 * ------------------------------------------------------------------ */

router.post(
  '/resend-verification',
  sensitiveLimiter,
  validate({ body: schemas.resendVerificationBody }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.valid.body.email });

    if (user && !user.emailVerified && user.status === 'active') {
      const verifyToken = await tokens.createEmailVerificationToken(user);
      const url = `${config.publicBaseUrl}/verify-email.html?token=${encodeURIComponent(verifyToken)}`;
      sendLater('verification', () => email.verificationEmail({ user, url }));
    }

    return ok(res, null, 'If that account needs confirming, a new link is on its way.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/auth/sessions
 * ------------------------------------------------------------------ */

router.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await Token.find({
      user: req.user._id,
      type: 'refresh',
      revokedAt: null,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('userAgent ip createdAt expiresAt');

    return ok(res, {
      sessions: sessions.map((session) => ({
        id: String(session._id),
        userAgent: session.userAgent,
        ip: session.ip,
        startedAt: session.createdAt,
        expiresAt: session.expiresAt,
      })),
    });
  })
);

module.exports = router;
