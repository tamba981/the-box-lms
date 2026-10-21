'use strict';

const mongoose = require('mongoose');

const { PAYMENT_STATUSES, PAYMENT_PURPOSES } = require('../lib/constants');
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
const PAYMENT_PROVIDERS = ['stripe', 'orange_money', 'lonestar_momo', 'manual', 'admin'];

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

    /**
     * What this money buys.
     *
     * Defaults to `enrollment`, which is what every payment made before this
     * field existed was. A document with no stored value reads as `enrollment`
     * too, so old records need no migration and the revenue reports keep
     * meaning what they meant.
     */
    purpose: { type: String, enum: PAYMENT_PURPOSES, default: 'enrollment', index: true },

    /**
     * The certificate a `certificate` payment settles.
     *
     * Stored on the order rather than looked up by (student, course) at
     * settlement: a student who has the course repeated, or whose certificate was
     * revoked and reissued, must settle the exact document the order was opened
     * for.
     */
    certificate: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', default: null },

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

    /*
     * Manual, offline orders.
     *
     * `orderId` deliberately has no `default`. A unique index combined with
     * `default: null` is a trap: a sparse index skips documents that do not have
     * the field, but `null` is a value, so every card payment would be indexed
     * as null and the second one would be rejected with a duplicate-key error.
     * Leaving the field absent keeps it out of the index entirely. The same
     * pattern on `providerReference` below is harmless only because that index is
     * not unique.
     */
    orderId: { type: String, unique: true, sparse: true, trim: true },

    /** When the student pressed "I have sent the payment". Not proof of anything. */
    markedPaidAt: { type: Date, default: null },
    /** Which of the academy's numbers they say they sent it to. */
    paidToNumber: { type: String, trim: true, maxlength: 40, default: null },
    /** Whatever reference the student's own receipt shows, if they gave one. */
    paymentReference: { type: String, trim: true, maxlength: 120, default: null },
    studentPhone: { type: String, trim: true, maxlength: 30, default: null },

    /** Set when an administrator confirms the money arrived. */
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: null },

    /** Administrator-only notes about this order. Never shown to the student. */
    notes: { type: String, trim: true, maxlength: 2000, default: null },

    /**
     * When an unpaid order stops being worth chasing. Expiry is evaluated when
     * an order is read rather than by a scheduled job — this deployment is a
     * single process with no scheduler, and adding one to flip a status flag
     * would be a moving part that can silently stop.
     */
    expiresAt: { type: Date, default: null },

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
/** The administrator's queue: manual orders waiting on a person. */
paymentSchema.index({ provider: 1, status: 1, createdAt: -1 });

/**
 * An unpaid order past its deadline.
 *
 * Computed rather than stored so that reading the queue cannot show an order as
 * live when it has lapsed, and so that no scheduled job has to exist for the
 * rule to hold. A paid order never expires, whatever its timestamp says.
 */
paymentSchema.methods.isExpired = function isExpired(now = Date.now()) {
  if (this.status !== 'pending' && this.status !== 'awaiting_verification') return false;
  return Boolean(this.expiresAt) && this.expiresAt.getTime() <= now;
};

paymentSchema.methods.toJSONForOwner = function toJSONForOwner(extra = {}) {
  return {
    id: String(this._id),
    orderId: this.orderId || null,
    courseId: String(this.course),
    // `enrollment` when the field is absent, which is every payment made before
    // certificates could be sold separately.
    purpose: this.purpose || 'enrollment',
    certificateId: this.certificate ? String(this.certificate) : null,
    amountCents: this.amountCents,
    currency: this.currency,
    amountLabel: formatCents(this.amountCents, this.currency),
    status: this.isExpired() ? 'expired' : this.status,
    method: this.method,
    provider: this.provider,
    checkoutUrl: this.status === 'pending' ? this.checkoutUrl : null,
    markedPaidAt: this.markedPaidAt,
    verifiedAt: this.verifiedAt,
    rejectionReason: this.status === 'rejected' ? this.rejectionReason : null,
    expiresAt: this.expiresAt,
    paidAt: this.paidAt,
    refundedAt: this.refundedAt,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model('Payment', paymentSchema);
