'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const config = require('../config/env');
const { ROLES } = require('../lib/constants');
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
     * Role is NEVER taken from a request body. It starts as 'student' and can
     * only be changed by an admin through the admin API, which validates the
     * value against ROLES.
     */
    role: { type: String, enum: ROLES, default: 'student', index: true },

    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },

    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },

    avatarUrl: { type: String, trim: true, default: null },
    bio: { type: String, trim: true, maxlength: 600, default: null },

    // Instructor profile fields (empty for students).
    headline: { type: String, trim: true, maxlength: 120, default: null },
    expertise: { type: [String], default: [] },

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
    avatarUrl: this.avatarUrl,
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
    avatarUrl: this.avatarUrl,
    headline: this.headline,
  };
};

module.exports = mongoose.model('User', userSchema);
