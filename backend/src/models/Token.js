'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { TOKEN_TYPES } = require('../lib/constants');
const { baseOptions } = require('./common');

/**
 * Refresh tokens, password-reset tokens and email-verification tokens.
 *
 * Only a SHA-256 hash of the token is stored. A database leak therefore does
 * not hand an attacker usable sessions. Lookup is by exact hash, which is a
 * constant-time-enough indexed comparison; the token itself is 48 random bytes
 * of entropy, so it cannot be guessed or brute-forced.
 */
const tokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: TOKEN_TYPES, required: true, index: true },

    tokenHash: { type: String, required: true, unique: true, index: true },

    /**
     * Rotation chain. When a refresh token is used, its replacement joins the
     * same family. If an already-rotated token is presented again — the
     * signature of a stolen token being replayed — the entire family is
     * revoked.
     */
    family: { type: String, required: true, index: true },
    replacedByHash: { type: String, default: null },

    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },

    userAgent: { type: String, default: null, maxlength: 400 },
    ip: { type: String, default: null, maxlength: 64 },
  },
  baseOptions
);

// Mongo removes expired documents automatically. `expireAfterSeconds: 0` means
// "delete as soon as expiresAt has passed", evaluated by the TTL monitor.
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

tokenSchema.statics.generate = function generate() {
  const raw = crypto.randomBytes(48).toString('base64url');
  return { raw, hash: tokenSchema.statics.hash(raw) };
};

tokenSchema.statics.hash = function hash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
};

tokenSchema.statics.newFamily = function newFamily() {
  return crypto.randomBytes(16).toString('hex');
};

tokenSchema.methods.isUsable = function isUsable() {
  return !this.revokedAt && !this.usedAt && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model('Token', tokenSchema);
