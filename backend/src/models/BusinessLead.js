'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * An enquiry from a company, university or government body.
 *
 * Stored before it is emailed, for the same reason contact messages are: a
 * provider having a bad minute must not lose what somebody typed.
 *
 * The export is deliberately closed. These are organisations that have asked to
 * hear from us, and an administrator works through them; the page only ever
 * confirms receipt.
 */
const businessLeadSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true, maxlength: 160 },
    contactName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 40, default: null },
    audience: {
      type: String,
      enum: ['business', 'university', 'government'],
      default: 'business',
      index: true,
    },
    teamSize: { type: String, trim: true, maxlength: 40, default: null },
    timeline: { type: String, trim: true, maxlength: 40, default: null },
    interests: { type: [String], default: [] },
    message: { type: String, trim: true, maxlength: 2000, default: null },

    status: {
      type: String,
      enum: ['new', 'contacted', 'closed'],
      default: 'new',
      index: true,
    },
    notifiedAt: { type: Date, default: null },
  },
  baseOptions
);

businessLeadSchema.index({ createdAt: -1 });

businessLeadSchema.methods.toAdminJSON = function toAdminJSON() {
  return {
    id: String(this._id),
    company: this.company,
    contactName: this.contactName,
    email: this.email,
    phone: this.phone,
    audience: this.audience,
    teamSize: this.teamSize,
    timeline: this.timeline,
    interests: this.interests,
    message: this.message,
    status: this.status,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('BusinessLead', businessLeadSchema);
