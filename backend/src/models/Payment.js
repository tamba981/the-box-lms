'use strict';

const mongoose = require('mongoose');

const { PAYMENT_STATUSES } = require('../lib/constants');
const { formatCents } = require('../lib/money');
const { baseOptions } = require('./common');

/**
 * Who can process a payment.
 *
 * `admin` is not a processor — it records money taken outside the platform, for
 * offline enrolments. The two mobile-money entries are Liberia's two networks;
 * there is no card *processor* here because Stripe, the implementation in
 * paymentService, is not available to Liberian businesses. A regional gateway
 * will need adding to this list as well as to the provider registry.
 */
const PAYMENT_PROVIDERS = ['stripe', 'orange_money', 'lonestar_momo', 'admin'];

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

    provider: { type: String, enum: PAYMENT_PROVIDERS, default: 'stripe' },

    /**
     * How the payer is being asked to pay, which is not the same as who processes
     * it: `stripe` is a card checkout, the mobile-money providers send a prompt
     * to the number below. Kept separate so reporting can group by method.
     */
    method: { type: String, enum: ['card', 'mobile_money', 'admin'], default: 'card' },

    /** The number the mobile-money prompt was sent to, for support and auditing. */
    payerPhone: { type: String, trim: true, default: null },

    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending', index: true },

    providerSessionId: { type: String, default: null, sparse: true },
    providerPaymentIntentId: { type: String, default: null, sparse: true },
    /** The provider's own transaction reference, used to match callbacks. */
    providerReference: { type: String, default: null, index: true, sparse: true },
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
