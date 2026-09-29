'use strict';

const mongoose = require('mongoose');

const { PAYMENT_STATUSES } = require('../lib/constants');
const { formatCents } = require('../lib/money');
const { baseOptions } = require('./common');

/**
 * A record of money changing hands for a course.
 *
 * Money is stored in minor units (cents) and never as a float. `idempotencyKey`
 * is unique so that a retried checkout or a duplicated webhook delivery cannot
 * create two payments — and therefore two enrollments — for one purchase.
 */
const paymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true, trim: true },

    provider: { type: String, enum: ['stripe', 'admin'], default: 'stripe' },

    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending', index: true },

    providerSessionId: { type: String, default: null, sparse: true },
    providerPaymentIntentId: { type: String, default: null, sparse: true },
    checkoutUrl: { type: String, default: null },

    idempotencyKey: { type: String, required: true, unique: true, index: true },

    /** Populated once the webhook confirms payment and access is granted. */
    enrollment: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, maxlength: 500, default: null },
  },
  baseOptions
);

paymentSchema.index({ student: 1, createdAt: -1 });
paymentSchema.index({ course: 1, status: 1 });

paymentSchema.methods.toJSONForOwner = function toJSONForOwner(extra = {}) {
  return {
    id: String(this._id),
    courseId: String(this.course),
    amountCents: this.amountCents,
    currency: this.currency,
    amountLabel: formatCents(this.amountCents, this.currency),
    status: this.status,
    provider: this.provider,
    checkoutUrl: this.status === 'pending' ? this.checkoutUrl : null,
    paidAt: this.paidAt,
    refundedAt: this.refundedAt,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model('Payment', paymentSchema);
