'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const config = require('../config/env');
const { ROLES } = require('../lib/constants');
const { formatDateOfBirth } = require('../lib/age');
const { baseOptions, lowercaseTrim } = require('./common');

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: [true, 'First name is required'], trim: true, maxlength: 80 },
    lastName: { type: String, required: [true, 'Last name is required'], trim: true, maxlength: 80 },

    email: {
      ...lowercaseTrim,
      required: [true, 'Email is required'],
      unique: true,
      index: true,
      maxlength: 254,
    },

    /**
     * `select: false` means the hash is never returned by a default query.
     * Code that genuinely needs it must opt in with .select('+password').
     */
    password: { type: String, required: true, select: false },

    phone: { type: String, trim: true, maxlength: 32 },

    /**
     * A calendar date, never an age. See lib/age.js for why.
     *
     * Not `required` at the schema level on purpose: accounts created before
     * sign-up asked for it (and every admin or instructor made by a script)
     * would start failing their own saves. Registration requires it — see the
     * register validator — and a profile can supply it later.
     */
    dateOfBirth: { type: Date, default: null },

    /** Where the student is, as they would write it: "Paynesville, Monrovia". */
    location: { type: String, trim: true, maxlength: 100, default: null },

    /**
     * Role is NEVER taken from a request body. It starts as 'student' and can
     * only be changed by an admin through the admin API, which validates the
     * value against ROLES.
     */
    role: { type: String, enum: ROLES, default: 'student', index: true },

    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },

    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },

    avatarUrl: { type: String, trim: true, default: null },

    /**
     * An uploaded avatar, stored in the document as bytes.
     *
     * `select: false` because it is by far the largest field on the document and
     * almost no query needs it — only the image endpoint does, and it opts in.
     * A profile picture at 120 KB would otherwise ride along on every user list.
     */
    avatarImage: { type: Buffer, select: false, default: undefined },
    avatarContentType: { type: String, default: null },

    /**
     * The address the image is served at.
     *
     * A random key rather than the user id, so the URL cannot be used to walk
     * the user table, and regenerated on every upload so a replaced picture is
     * never served from a cache under the old one.
     */
    avatarKey: { type: String, default: null, index: true },

    bio: { type: String, trim: true, maxlength: 600, default: null },

    // Instructor profile fields (empty for students).
    headline: { type: String, trim: true, maxlength: 120, default: null },
    expertise: { type: [String], default: [] },

    /**
     * Instructor credentials. Shown on the course page and the profile, so they
     * are part of the public author card rather than private data.
     */
    videoIntroUrl: { type: String, trim: true, maxlength: 500, default: null },
    qualifications: { type: String, trim: true, maxlength: 500, default: null },
    yearsExperience: { type: Number, min: 0, max: 80, default: null },
    languages: { type: [String], default: [] },

    /**
     * An uploaded CV, stored as bytes for the same reason as `avatarImage`:
     * `select: false` keeps half a megabyte off every user query, and BSON
     * binary holds it in roughly the space of the file rather than the 4/3 that
     * base64 costs. Only the CV endpoints opt in.
     *
     * A CV is personal data, so it is never serialised into any payload. The
     * public side learns one bit about it — whether it was approved.
     */
    cvImage: { type: Buffer, select: false, default: undefined },
    cvContentType: { type: String, default: null },
    cvOriginalFilename: { type: String, trim: true, maxlength: 200, default: null },
    cvStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: null, index: true },
    cvUploadedAt: { type: Date, default: null },
    cvReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cvReviewedAt: { type: Date, default: null },
    cvRejectionReason: { type: String, trim: true, maxlength: 500, default: null },

    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  baseOptions
);

userSchema.index({ createdAt: -1 });

userSchema.virtual('fullName').get(function fullName() {
  return `${this.firstName} ${this.lastName}`.trim();
});

/**
 * The address a browser should load for this person's picture.
 *
 * An uploaded image wins over a profile URL. The upload is the more recent
 * intent, and a student who replaced a broken link with a real photograph
 * should not still be shown the broken link.
 *
 * Every caller keeps reading `avatarUrl`, so nothing downstream had to change.
 */
userSchema.methods.avatarLink = function avatarLink() {
  if (this.avatarKey) return `/api/v1/avatars/${this.avatarKey}`;
  return this.avatarUrl || null;
};

/**
 * Hash on the way to the database. `isModified` keeps this idempotent: a
 * document loaded and re-saved without touching the password is untouched,
 * so an already-hashed value is never hashed a second time.
 */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  try {
    this.password = await bcrypt.hash(this.password, config.bcryptRounds);
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!candidate || !this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

/**
 * The only shape of a user that ever leaves the server. Explicitly whitelisted
 * rather than built by deleting fields, so a future schema addition cannot
 * accidentally leak by being forgotten here.
 *
 * Callers may pass extra keys alongside the `includePrivate` flag, the way
 * `toCardJSON(extra)` on a course does. The admin user list relies on this to
 * attach per-user enrolment counts: it aggregated them, passed them as
 * `stats`, and had them silently discarded because only `includePrivate` was
 * ever read from the options object.
 */
userSchema.methods.toPublicJSON = function toPublicJSON(options = {}) {
  const { includePrivate = false, ...extra } = options;

  const payload = {
    id: String(this._id),
    firstName: this.firstName,
    lastName: this.lastName,
    fullName: this.fullName,
    role: this.role,
    avatarUrl: this.avatarLink(),
    bio: this.bio,
    headline: this.headline,
    expertise: this.expertise,
    createdAt: this.createdAt,
  };

  if (includePrivate) {
    payload.email = this.email;
    payload.phone = this.phone;
    payload.status = this.status;
    payload.emailVerified = this.emailVerified;
    payload.lastLoginAt = this.lastLoginAt;
    // Sent as a date-only string: a browser input needs `YYYY-MM-DD`, and a
    // full timestamp would drift a day across timezones for no benefit.
    payload.dateOfBirth = formatDateOfBirth(this.dateOfBirth);
    payload.location = this.location;

    /**
     * The instructor's own credentials, so the profile form can repopulate.
     *
     * These are public on a course page, but only through the author card's
     * `credentials` object — this copy exists so an instructor editing their
     * profile sees what is currently saved.
     */
    payload.videoIntroUrl = this.videoIntroUrl;
    payload.qualifications = this.qualifications;
    payload.yearsExperience = this.yearsExperience;
    payload.languages = this.languages;

    /**
     * The CV review state, for the person themselves and for administrators.
     *
     * The rejection reason is only sent while the CV is actually rejected — a
     * later approval would otherwise leave a stale explanation of a refusal
     * sitting in the payload.
     */
    payload.cvStatus = this.cvStatus;
    payload.cvUploadedAt = this.cvUploadedAt;
    payload.cvOriginalFilename = this.cvOriginalFilename;
    if (this.cvStatus === 'rejected') payload.cvRejectionReason = this.cvRejectionReason;
  }

  return { ...payload, ...extra };
};

/** Public-facing author card, used for instructors on course and post views. */
userSchema.methods.toAuthorJSON = function toAuthorJSON() {
  return {
    id: String(this._id),
    firstName: this.firstName,
    lastName: this.lastName,
    fullName: this.fullName,
    role: this.role,
    avatarUrl: this.avatarLink(),
    headline: this.headline,
    /**
     * Only what a stranger may see about an instructor's credentials.
     *
     * `cvApproved` is a single boolean: the course page can say the CV has been
     * checked without revealing that one exists, was rejected, or is awaiting
     * review. The file itself is never public.
     */
    credentials: {
      videoIntroUrl: this.videoIntroUrl,
      qualifications: this.qualifications,
      yearsExperience: this.yearsExperience,
      languages: this.languages,
      cvApproved: this.cvStatus === 'approved',
    },
  };
};

module.exports = mongoose.model('User', userSchema);
