'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * One administrator signing in as somebody else.
 *
 * Impersonation is necessary — "I cannot see the button you are describing" is
 * most support conversations — and it is also the single most dangerous thing an
 * administrator can do, because every action taken afterwards is recorded against
 * the user, not against the person who took it. So it is written down, here,
 * before the session is handed out.
 *
 * What is deliberately *not* stored: the user's password (never touched) and
 * nothing of the impersonated session itself.
 */
const impersonationSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Why, in the administrator's own words. Required — see the route. */
    reason: { type: String, required: true, maxlength: 300 },

    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 400 },

    startedAt: { type: Date, default: Date.now, index: true },
    /** Set when the administrator says they are back; null while running. */
    endedAt: { type: Date, default: null },
  },
  baseOptions
);

impersonationSchema.index({ createdAt: -1 });
impersonationSchema.index({ user: 1, createdAt: -1 });

impersonationSchema.methods.toAdminJSON = function toAdminJSON() {
  return {
    id: String(this._id),
    admin: this.admin && this.admin.toPublicJSON ? this.admin.toPublicJSON() : String(this.admin),
    user: this.user && this.user.toPublicJSON ? this.user.toPublicJSON() : String(this.user),
    reason: this.reason,
    ip: this.ip,
    startedAt: this.startedAt,
    endedAt: this.endedAt,
  };
};

module.exports = mongoose.model('Impersonation', impersonationSchema);
