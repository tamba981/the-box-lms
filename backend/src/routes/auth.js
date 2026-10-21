'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const express = require('express');

const Enrollment = require('../models/Enrollment');
const Notification = require('../models/Notification');
const Token = require('../models/Token');
const User = require('../models/User');
const email = require('../services/email');
const tokens = require('../services/tokenService');

const config = require('../config/env');
const { decodeAvatar } = require('../lib/avatar');
const { decodeCv, sanitiseFilename } = require('../lib/document');
const { sendCv } = require('../lib/cvDownload');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { conflict, unauthorized, badRequest, forbidden, notFound } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate, extractBearerToken } = require('../middleware/auth');
const { authLimiter, sensitiveLimiter, writeLimiter } = require('../middleware/rateLimit');
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
    const { firstName, lastName, email: address, password, phone, dateOfBirth, location } = req.valid.body;

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
      // The schema has already proved this is a real date and that the student
      // is old enough; storing the date rather than the age keeps it true.
      dateOfBirth,
      location,
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
 * POST /api/v1/auth/register-instructor
 * ------------------------------------------------------------------ */

/**
 * An instructor application.
 *
 * Deliberately not a variant of `POST /auth/register`. That endpoint exists to
 * create students, and it hard-codes the role so that no request can choose
 * one. Here the role and status are fixed by the server - `instructor` and
 * `pending` - and nothing in the body can reach either.
 *
 * No session is issued. A pending applicant cannot sign in, so handing them
 * tokens would produce an account that looks like it works until the first
 * request that needs a role. The acknowledgement email is the receipt.
 */
router.post(
  '/register-instructor',
  authLimiter,
  validate({ body: schemas.registerInstructorBody }),
  asyncHandler(async (req, res) => {
    const {
      firstName,
      lastName,
      email: address,
      password,
      phone,
      dateOfBirth,
      location,
      credentialSummary,
      qualifications,
      yearsExperience,
      expertise,
      videoIntroUrl,
      cvImage,
      cvFilename,
    } = req.valid.body;

    const existing = await User.findOne({ email: address }).select('_id');
    if (existing) {
      throw conflict('An account already exists for that email address. Sign in, or apply with another one.', {
        code: 'EMAIL_IN_USE',
        details: [{ field: 'email', message: 'Already registered' }],
      });
    }

    const user = await User.create({
      firstName,
      lastName,
      email: address,
      password,
      phone: phone || undefined,
      dateOfBirth,
      location,
      role: 'instructor',
      status: 'pending',
      credentialSummary: credentialSummary || null,
      qualifications: qualifications || null,
      yearsExperience: typeof yearsExperience === 'number' ? yearsExperience : null,
      expertise: Array.isArray(expertise) ? expertise : [],
      videoIntroUrl: videoIntroUrl || null,
      appliedAt: new Date(),
    });

    if (cvImage) {
      const decoded = decodeCv(cvImage);

      if (!decoded.ok) {
        /**
         * The account was created and the CV did not pass. Remove the account
         * rather than leave a half-finished application: a pending applicant
         * cannot sign in, so there would be no way for them to attach the file
         * afterwards.
         */
        await User.deleteOne({ _id: user._id });
        throw badRequest(decoded.message, {
          code: 'INVALID_CV',
          details: [{ field: 'cvImage', message: decoded.message }],
        });
      }

      user.cvImage = decoded.buffer;
      user.cvContentType = 'application/pdf';
      user.cvOriginalFilename = sanitiseFilename(cvFilename);
      user.cvStatus = 'pending';
      user.cvUploadedAt = new Date();
      await user.save();
    }

    // Fire-and-forget, like every other email in this file: the application is
    // already stored, and a mail provider that is down must not turn a
    // successful submission into a 500 the applicant would try again.
    sendLater('instructor application received', () => email.instructorApplicationReceivedEmail({ user }));

    return created(
      res,
      { status: 'pending', email: user.email },
      'Application received. We review every application within 48 hours.'
    );
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

    if (user.status === 'pending') {
      throw unauthorized(
        'Your instructor application is still being reviewed. We will email you as soon as it is decided.',
        { code: 'ACCOUNT_PENDING' }
      );
    }

    if (user.status === 'rejected') {
      throw unauthorized(
        'That application was not approved. Reply to the email we sent if you believe that is wrong.',
        { code: 'ACCOUNT_REJECTED' }
      );
    }

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
    const { firstName, lastName, phone, bio, avatarUrl, headline, expertise, dateOfBirth, location } =
      req.valid.body;

    if (firstName !== undefined) req.user.firstName = firstName;
    if (lastName !== undefined) req.user.lastName = lastName;
    if (phone !== undefined) req.user.phone = phone || null;
    if (bio !== undefined) req.user.bio = bio || null;
    if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl || null;
    if (headline !== undefined) req.user.headline = headline || null;
    if (expertise !== undefined) req.user.expertise = expertise;
    if (dateOfBirth !== undefined) req.user.dateOfBirth = dateOfBirth;
    if (location !== undefined) req.user.location = location;

    const { videoIntroUrl, qualifications, yearsExperience, languages } = req.valid.body;
    if (videoIntroUrl !== undefined) req.user.videoIntroUrl = videoIntroUrl;
    if (qualifications !== undefined) req.user.qualifications = qualifications || null;
    if (yearsExperience !== undefined) req.user.yearsExperience = yearsExperience;
    if (languages !== undefined) req.user.languages = languages;

    await req.user.save();

    return ok(res, { user: req.user.toPublicJSON({ includePrivate: true }) }, 'Profile updated.');
  })
);

/* ------------------------------------------------------------------ *
 * PUT /api/v1/auth/me/avatar — replace your photo
 * ------------------------------------------------------------------ */

router.put(
  '/me/avatar',
  authenticate,
  sensitiveLimiter,
  validate({ body: schemas.avatarBody }),
  asyncHandler(async (req, res) => {
    const decoded = decodeAvatar(req.valid.body.image);

    if (!decoded.ok) {
      throw badRequest(decoded.message, {
        code: 'INVALID_AVATAR',
        details: [{ field: 'image', message: decoded.message }],
      });
    }

    // A new key on every upload: the old address stops resolving, and no cache
    // anywhere can serve the previous picture under the new one.
    req.user.avatarImage = decoded.buffer;
    req.user.avatarContentType = decoded.contentType;
    req.user.avatarKey = crypto.randomBytes(16).toString('hex');

    await req.user.save();

    return ok(res, { user: req.user.toPublicJSON({ includePrivate: true }) }, 'Your photo has been updated.');
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/auth/me/avatar — go back to initials
 * ------------------------------------------------------------------ */

router.delete(
  '/me/avatar',
  authenticate,
  sensitiveLimiter,
  asyncHandler(async (req, res) => {
    await User.updateOne(
      { _id: req.user._id },
      { $unset: { avatarImage: '', avatarContentType: '', avatarKey: '' } }
    );

    const user = await User.findById(req.user._id);

    return ok(res, { user: user.toPublicJSON({ includePrivate: true }) }, 'Your photo has been removed.');
  })
);

/* ------------------------------------------------------------------ *
 * PUT /api/v1/auth/me/cv â€” replace your CV
 *
 * Uploading always returns the CV to `pending`: a document that was approved is
 * a different document once it is replaced, and it must be read again.
 * ------------------------------------------------------------------ */

router.put(
  '/me/cv',
  authenticate,
  /**
   * The write limiter, not the sensitive one.
   *
   * `sensitiveLimiter` is keyed on the email in the body, and this request has
   * none — so every CV upload from an office behind one address would share a
   * single ten-per-hour bucket with password changes and photo uploads. Sixty a
   * minute against an authenticated account, on top of the global API limiter,
   * is the right shape for a file upload.
   */
  writeLimiter,
  validate({ body: schemas.cvBody }),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'instructor' && req.user.role !== 'admin') {
      throw forbidden('Only instructors can upload a CV.', { code: 'CV_INSTRUCTOR_ONLY' });
    }

    const decoded = decodeCv(req.valid.body.image);

    if (!decoded.ok) {
      throw badRequest(decoded.message, {
        code: 'INVALID_CV',
        details: [{ field: 'image', message: decoded.message }],
      });
    }

    req.user.cvImage = decoded.buffer;
    req.user.cvContentType = 'application/pdf';
    req.user.cvOriginalFilename = sanitiseFilename(req.valid.body.filename);
    req.user.cvStatus = 'pending';
    req.user.cvUploadedAt = new Date();
    // A new document has not been reviewed by anyone, whatever the old one said.
    req.user.cvReviewedBy = null;
    req.user.cvReviewedAt = null;
    req.user.cvRejectionReason = null;

    await req.user.save();

    // Uploading twice should not read as two submissions, so this is the
    // acknowledgement, not a queue-position update.
    sendLater('cv-submitted', () => email.cvSubmittedEmail({ user: req.user }));

    return ok(res, { user: req.user.toPublicJSON({ includePrivate: true }) }, 'Your CV has been sent for review.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/auth/me/cv â€” download your own CV
 * ------------------------------------------------------------------ */

router.get(
  '/me/cv',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+cvImage');

    // No CV, and no way to tell whether one ever existed.
    if (!user || !user.cvImage || user.cvImage.length === 0) {
      throw notFound('You have not uploaded a CV yet.', { code: 'CV_NOT_FOUND' });
    }

    sendCv(res, user);
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

    /**
     * The message must not vary with whether the address exists — that is the
     * account-enumeration oracle this endpoint is written to avoid. It may vary
     * with the deployment, which is not a fact about any account: with no mail
     * provider configured nothing can be delivered, so telling somebody a link is
     * on its way would promise the one thing this server cannot do. The flag lets
     * the page say something true instead of being told a comforting untruth.
     */
    return ok(
      res,
      { emailEnabled: config.email.enabled },
      config.email.enabled
        ? 'If that email address has an account, a password reset link is on its way.'
        : 'Email is not configured on this deployment, so a reset link cannot be sent. An administrator can reset your password instead.'
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
