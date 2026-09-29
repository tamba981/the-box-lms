'use strict';

const express = require('express');
const { z } = require('zod');

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');

const paymentService = require('../services/paymentService');

const config = require('../config/env');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created } = require('../lib/respond');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { formatCents } = require('../lib/money');
const { parsePagination, paginated } = require('../lib/pagination');

const { authenticate, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { paginationQuery } = require('../validators/auth');

const router = express.Router();

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

/* ------------------------------------------------------------------ *
 * GET /api/v1/payments/config — what the front-end should expect
 * ------------------------------------------------------------------ */

router.get(
  '/config',
  asyncHandler(async (req, res) =>
    ok(res, {
      enabled: config.stripe.enabled,
      // Deliberately no key material: the publishable key is not needed while
      // checkout is handled by Stripe's hosted page.
      provider: 'stripe',
    })
  )
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/payments/checkout/:courseId
 * ------------------------------------------------------------------ */

router.post(
  '/checkout/:courseId',
  authenticate,
  validate({ params: z.object({ courseId: objectId }) }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    if (course.status !== 'published') {
      throw notFound('That course is not open for enrollment.', { code: 'COURSE_NOT_PUBLISHED' });
    }

    // You cannot buy a course you already have access to.
    const already = await Enrollment.findOne({
      student: req.user._id,
      course: course._id,
      status: { $ne: 'cancelled' },
    });

    if (already) {
      throw forbidden('You are already enrolled in this course.', { code: 'ALREADY_ENROLLED' });
    }

    const { payment, checkoutUrl } = await paymentService.createCheckoutSession({
      user: req.user,
      course,
    });

    return created(
      res,
      { payment: payment.toJSONForOwner(), checkoutUrl },
      'Checkout ready.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/payments/webhook — Stripe
 * ------------------------------------------------------------------ */

/**
 * This route receives the raw request body: Stripe's signature is computed over
 * the exact bytes sent, so it is mounted with `express.raw` in app.js and must
 * not be parsed as JSON before the signature is checked.
 *
 * It always answers 200 for events it has accepted or deliberately ignored, so
 * Stripe does not retry a delivery that will never succeed.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    const verification = paymentService.verifyWebhookSignature(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );

    if (!verification.valid) {
      logger.warn('rejected stripe webhook', { reason: verification.reason });
      // 400 tells Stripe this delivery will never be accepted.
      return res.status(400).json({ received: false, reason: verification.reason });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ received: false, reason: 'invalid_json' });
    }

    logger.info('stripe webhook received', { type: event.type, id: event.id });

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const result = await paymentService.fulfillCheckoutSession(event.data.object);
          logger.info('checkout completed', result);
          break;
        }

        // Deliberately not treated as fulfilment: the payment has not settled.
        case 'checkout.session.async_payment_succeeded':
          await paymentService.fulfillCheckoutSession(event.data.object);
          break;

        case 'checkout.session.expired':
          await paymentService.markFailed(event.data.object, 'Checkout session expired');
          break;

        case 'payment_intent.payment_failed':
          await Payment.findOneAndUpdate(
            { providerPaymentIntentId: event.data.object.id, status: { $ne: 'paid' } },
            { $set: { status: 'failed', failureReason: event.data.object.last_payment_error?.message || 'Payment failed' } }
          );
          break;

        default:
          // Unhandled event types are acknowledged so Stripe stops retrying.
          logger.debug('unhandled stripe event', { type: event.type });
      }
    } catch (error) {
      /**
       * A failure here is ours, not Stripe's — most likely a transient database
       * problem. Returning 500 makes Stripe retry, which is what we want,
       * because fulfilment is idempotent.
       */
      logger.error('stripe webhook processing failed', { type: event.type, error });
      return res.status(500).json({ received: false, reason: 'processing_failed' });
    }

    return res.status(200).json({ received: true });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/payments/me
 * ------------------------------------------------------------------ */

router.get(
  '/me',
  authenticate,
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const [payments, total] = await Promise.all([
      Payment.find({ student: req.user._id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments({ student: req.user._id }),
    ]);

    const courses = await Course.find({ _id: { $in: payments.map((payment) => payment.course) } }).select('title slug');
    const byId = new Map(courses.map((course) => [String(course._id), course]));

    return ok(
      res,
      paginated(
        payments.map((payment) => {
          const course = byId.get(String(payment.course));
          return payment.toJSONForOwner({
            courseTitle: course ? course.title : null,
            courseSlug: course ? course.slug : null,
          });
        }),
        total,
        { page, limit }
      )
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/payments — admin
 * ------------------------------------------------------------------ */

router.get(
  '/',
  authenticate,
  requireAdmin,
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const [payments, total, revenue] = await Promise.all([
      Payment.find({ status: 'paid' }).sort({ paidAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments({ status: 'paid' }),
      Payment.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: '$currency', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
      ]),
    ]);

    return ok(res, {
      ...paginated(
        payments.map((payment) => payment.toJSONForOwner()),
        total,
        { page, limit }
      ),
      // Money summed in integer cents, never as a float.
      revenueByCurrency: revenue
        .map((row) => ({
          currency: row._id,
          totalCents: row.total,
          totalLabel: formatCents(row.total, row._id),
          count: row.count,
        }))
        .sort((a, b) => b.totalCents - a.totalCents),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/payments/:id/refund — admin
 * ------------------------------------------------------------------ */

router.post(
  '/:id/refund',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findById(req.valid.params.id);
    if (!payment) throw notFound('That payment could not be found.', { code: 'PAYMENT_NOT_FOUND' });

    if (payment.status !== 'paid') {
      throw badRequest('Only a completed payment can be refunded.', { code: 'NOT_REFUNDABLE' });
    }

    /**
     * The refund itself is issued in the Stripe dashboard or by a separate
     * refund call; what this endpoint owns is the local consequence: the
     * enrollment is closed and the payment is marked refunded.
     */
    payment.status = 'refunded';
    payment.refundedAt = new Date();
    await payment.save();

    if (payment.enrollment) {
      await Enrollment.updateOne({ _id: payment.enrollment }, { $set: { status: 'cancelled' } });
    }

    return ok(res, { payment: payment.toJSONForOwner() }, 'Payment marked as refunded and access withdrawn.');
  })
);

module.exports = router;
