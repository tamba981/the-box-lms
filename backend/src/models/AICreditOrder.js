'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { formatCents } = require('../lib/money');
const { baseOptions } = require('./common');

const AI_ORDER_STATUSES = Object.freeze([
  'pending',
  'awaiting_verification',
  'paid',
  'rejected',
  'expired',
]);

/** No confusable characters: a reference gets read down a phone line. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * A student buying AI credits.
 *
 * Deliberately **not** a `Payment`. A payment record requires a course, and every
 * reader of it — settlement, enrolment, revenue reporting, the admin queue —
 * assumes one. Credits are bought for an account, not for a course, and bending
 * that model would put a conditional in every place that trusts it. The cost of a
 * separate collection is one more admin list; the cost of the other route is a
 * class of bug that only shows up when somebody buys credits and the settlement
 * code tries to enrol them in nothing.
 *
 * The lifecycle mirrors the manual course orders, because that is the flow the
 * academy already runs by hand: an order is opened, the student sends mobile
 * money and says so, an administrator checks the account and confirms, and only
 * then are the credits granted.
 */
const aiCreditOrderSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** How many credits the money buys, fixed at the price in force when it was opened. */
    credits: { type: Number, required: true, min: 1 },

    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true, trim: true },

    /** Printed to the student and used as the payment reference. */
    reference: { type: String, required: true, unique: true, index: true, trim: true },

    status: { type: String, enum: AI_ORDER_STATUSES, default: 'pending', index: true },

    /** The number they say they paid from, for matching against the statement. */
    payerPhone: { type: String, trim: true, default: null },

    /** When they pressed "I have sent it". Not evidence of anything on its own. */
    submittedAt: { type: Date, default: null },

    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },

    notes: { type: String, default: null, maxlength: 1000 },

    /** How many credits were actually granted, recorded at the moment they were. */
    creditsGranted: { type: Number, default: 0, min: 0 },

    expiresAt: { type: Date, required: true, index: true },
  },
  baseOptions
);

aiCreditOrderSchema.index({ status: 1, createdAt: -1 });
aiCreditOrderSchema.index({ student: 1, status: 1, createdAt: -1 });

/** `AI-7K4M2Q` — short, unambiguous when spoken, and unique by construction. */
aiCreditOrderSchema.statics.newReference = function newReference() {
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `AI-${out}`;
};

aiCreditOrderSchema.methods.amountLabel = function amountLabel() {
  return formatCents(this.amountCents, this.currency);
};

/** What the student sees. Nothing about who verified it or when. */
aiCreditOrderSchema.methods.toStudentJSON = function toStudentJSON() {
  return {
    id: String(this._id),
    reference: this.reference,
    credits: this.credits,
    amountCents: this.amountCents,
    amountLabel: this.amountLabel(),
    status: this.status,
    payerPhone: this.payerPhone,
    createdAt: this.createdAt,
    submittedAt: this.submittedAt,
    expiresAt: this.expiresAt,
    rejectionReason: this.status === 'rejected' ? this.rejectionReason : null,
  };
};

aiCreditOrderSchema.methods.toAdminJSON = function toAdminJSON(extra = {}) {
  return {
    ...this.toStudentJSON(),
    student: this.student && this.student.toPublicJSON
      ? this.student.toPublicJSON()
      : String(this.student),
    verifiedAt: this.verifiedAt,
    notes: this.notes,
    creditsGranted: this.creditsGranted,
    ...extra,
  };
};

module.exports = mongoose.model('AICreditOrder', aiCreditOrderSchema);
module.exports.AI_ORDER_STATUSES = AI_ORDER_STATUSES;
