'use strict';

const express = require('express');
const { z } = require('zod');

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');

const paymentService = require('../services/paymentService');
const mobileMoneyService = require('../services/mobileMoneyService');

const config = require('../config/env');
const { PAYMENT_PURPOSES } = require('../lib/constants');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created } = require('../lib/respond');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { formatCents } = require('../lib/money');
const { parsePagination, paginated } = require('../lib/pagination');

const { authenticate, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const { paginationQuery } = require('../validators/auth');

const router = express.Router();

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

/**
 * The reference written on a manual order.
 *
 * Matched case-insensitively because a student reading `WGA-…-H9FU94` off a
 * screen may type it in either case, and the service upper-cases before looking
 * it up. Rejecting a correctly-formed reference over its casing would be a
 * needless dead end.
 */
const orderRef = z
  .string()
  .trim()
  .regex(/^WGA-\d{10,16}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/i, 'That is not an order reference');

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
 * GET /api/v1/payments/methods — what a payer can actually choose
 * ------------------------------------------------------------------ */

/**
 * Reports every method the platform knows about, whether it is usable, and what
 * is missing where it is not.
 *
 * Listing a disabled method rather than hiding it is deliberate. A student who
 * has only Orange Money needs to know that the option exists and is not yet
 * switched on, which is a different message from that option never having been
 * considered. Nothing here exposes key material — cards are a redirect to
 * Stripe's hosted page, so no publishable key is involved.
 */
router.get(
  '/methods',
  asyncHandler(async (req, res) =>
    ok(res, {
      methods: [
        {
          id: 'card',
          label: 'Debit or credit card',
          kind: 'card',
          currency: 'usd',
          enabled: config.stripe.enabled,
          missing: config.stripe.enabled ? [] : ['STRIPE_SECRET_KEY'],
          // Stated plainly because it is not a configuration oversight: Stripe
          // does not accept businesses registered in Liberia.
          note: config.stripe.enabled
            ? null
            : 'Card payments need a gateway that supports Liberia.',
        },
        {
          id: 'manual',
          label: 'Mobile money transfer',
          kind: 'manual',
          currency: 'usd',
          enabled: config.manualPayment.numbers.length > 0,
          missing: config.manualPayment.numbers.length ? [] : ['PAYMENT_MOBILE_MONEY_NUMBERS'],
          note: config.manualPayment.numbers.length
            ? 'Send the amount to one of our numbers. We confirm it by hand, usually within 30 minutes.'
            : 'Contact the academy to arrange payment.',
          // Shown on the payment screen. Public like the footer numbers already
          // are — these are where money is sent, not a secret.
          numbers: config.manualPayment.numbers,
          // Who receives the transfer. A learner sending money to a number needs
          // to know whose name to expect on the confirmation prompt.
          payTo: config.manualPayment.payTo || 'Darlington Tamba',
        },
        ...mobileMoneyService.listProviders(),
      ],
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
 * POST /api/v1/payments/checkout/:courseId/mobile-money
 * ------------------------------------------------------------------ */

/**
 * A separate route rather than a `method` field on the card flow.
 *
 * The two differ in more than a parameter: cards redirect the browser to Stripe
 * and settle by webhook, whereas mobile money sends a prompt to a handset and
 * settles by callback. Sharing one handler would mean one function with two
 * shapes of failure, and the card path already works and is covered by tests.
 */
router.post(
  '/checkout/:courseId/mobile-money',
  authenticate,
  validate({
    params: z.object({ courseId: objectId }),
    body: z.object({
      provider: z.string().trim().min(1, 'Choose a mobile money provider').max(40),
      phoneNumber: z.string().trim().min(7, 'Enter the number to charge').max(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    if (course.status !== 'published') {
      throw notFound('That course is not open for enrollment.', { code: 'COURSE_NOT_PUBLISHED' });
    }

    const { payment, instructions } = await mobileMoneyService.initiateCharge({
      user: req.user,
      course,
      providerId: req.valid.body.provider,
      phoneNumber: req.valid.body.phoneNumber,
    });

    return created(
      res,
      { payment: payment.toJSONForOwner(), instructions },
      'Approve the prompt on your phone to complete the payment.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * Manual orders — paying by transfer, confirmed by hand
 * ------------------------------------------------------------------ */

/**
 * Open an order for a paid course.
 *
 * The amount is read from the course, never from the request, so a caller
 * cannot choose what to pay. What comes back is a reference and a set of
 * numbers — nothing has been charged and nothing has been granted.
 */
router.post(
  '/manual',
  authenticate,
  writeLimiter,
  validate({
    body: z.object({
      courseId: objectId,
      studentPhone: z.string().trim().max(30).optional().nullable(),
      /** `enrollment` unless the student is claiming a certificate. */
      purpose: z.enum(PAYMENT_PURPOSES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.body.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    if (course.status !== 'published') {
      throw notFound('That course is not open for enrollment.', { code: 'COURSE_NOT_PUBLISHED' });
    }

    const purpose = req.valid.body.purpose || 'enrollment';

    /**
     * You cannot buy a course you already have — but a certificate order is
     * exactly the case where the student does already have it. The service
     * checks that they finished the course, and that the certificate is the one
     * still waiting to be paid for.
     */
    if (purpose === 'enrollment') {
      const already = await Enrollment.findOne({
        student: req.user._id,
        course: course._id,
        status: { $ne: 'cancelled' },
      });

      if (already) {
        throw forbidden('You are already enrolled in this course.', { code: 'ALREADY_ENROLLED' });
      }
    }

    const { payment, reused } = await paymentService.createManualOrder({
      user: req.user,
      course,
      purpose,
      studentPhone: req.valid.body.studentPhone || null,
    });

    const payload = {
      order: payment.toJSONForOwner({ courseTitle: course.title }),
      instructions: paymentService.manualInstructions(),
    };

    // A second press within the window returns the same order rather than a
    // second one, so the button is safe to double-tap on a slow connection.
    return reused
      ? ok(res, payload, 'You already have an order open for this. It is below.')
      : created(res, payload, 'Order created. Send the payment, then tell us it is done.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/payments/manual/:orderId/mark-paid
 * ------------------------------------------------------------------ */

/**
 * "I have sent the payment."
 *
 * This is the student's word, not evidence of anything, so it moves the order
 * into the queue a person works through rather than granting any access.
 */
router.post(
  '/manual/:orderId/mark-paid',
  authenticate,
  writeLimiter,
  validate({
    params: z.object({ orderId: orderRef }),
    body: z.object({
      paidToNumber: z.string().trim().max(40).optional().nullable(),
      paymentReference: z.string().trim().max(120).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const payment = await paymentService.findManualOrder(req.valid.params.orderId);
    if (!payment) throw notFound('That order could not be found.', { code: 'ORDER_NOT_FOUND' });

    if (String(payment.student) !== String(req.user._id)) {
      throw forbidden('That order belongs to somebody else.', { code: 'NOT_YOUR_ORDER' });
    }

    const { payment: updated } = await paymentService.markManualOrderPaid({
      payment,
      paidToNumber: req.valid.body.paidToNumber || null,
      paymentReference: req.valid.body.paymentReference || null,
    });

    return ok(
      res,
      { order: updated.toJSONForOwner() },
      'Thank you. We will check and confirm your enrolment, usually within 30 minutes.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/payments/manual/:orderId
 * ------------------------------------------------------------------ */

/** So a student can see where their order has got to without asking. */
router.get(
  '/manual/:orderId',
  authenticate,
  validate({ params: z.object({ orderId: orderRef }) }),
  asyncHandler(async (req, res) => {
    const payment = await paymentService.findManualOrder(req.valid.params.orderId);
    if (!payment) throw notFound('That order could not be found.', { code: 'ORDER_NOT_FOUND' });

    const isOwner = String(payment.student) === String(req.user._id);
    if (!isOwner && req.user.role !== 'admin') {
      throw forbidden('That order belongs to somebody else.', { code: 'NOT_YOUR_ORDER' });
    }

    return ok(res, { order: payment.toJSONForOwner() });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/payments/callback/:provider — mobile money
 * ------------------------------------------------------------------ */

/**
 * Mounted with `express.raw` for the same reason as the Stripe webhook: the
 * signature covers the exact bytes sent, so the body must not be parsed first.
 *
 * The signature is our own shared secret, not (yet) whichever scheme the
 * provider uses. See the note at the top of mobileMoneyService.
 */
router.post(
  '/callback/:provider',
  validate({ params: z.object({ provider: z.string().trim().min(1).max(40) }) }),
  asyncHandler(async (req, res) => {
    const provider = mobileMoneyService.getProvider(req.valid.params.provider);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    const verification = mobileMoneyService.verifyCallback(
      provider,
      rawBody,
      req.headers['x-callback-signature']
    );

    if (!verification.valid) {
      logger.warn('rejected mobile money callback', {
        provider: req.valid.params.provider,
        reason: verification.reason,
      });
      return res.status(400).json({ received: false, reason: verification.reason });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ received: false, reason: 'invalid_json' });
    }

    try {
      const result = await mobileMoneyService.processCallback(provider, payload);
      logger.info('mobile money callback processed', { provider: provider.id, ...result });
    } catch (error) {
      // Ours, not theirs — most likely transient. 500 so the provider retries;
      // settlement is idempotent, so a retry is safe.
      logger.error('mobile money callback failed', { provider: provider.id, error });
      return res.status(500).json({ received: false, reason: 'processing_failed' });
    }

    return res.status(200).json({ received: true });
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
          /**
           * Stripe fires this when checkout finishes, which is not the same as
           * the money arriving. With asynchronous methods — bank debits,
           * vouchers — payment_status is still 'unpaid' at this point, and
           * fulfilling here would hand over the course before the payment
           * settled. Stripe's own guidance is to check this field before
           * granting anything.
           *
           * This is not currently reachable with cards, which is exactly why it
           * matters: enabling another payment method is a dashboard toggle, not
           * a code change, so the hole would open silently.
           */
          if (event.data.object.payment_status !== 'paid') {
            logger.info('checkout completed but unpaid — waiting for settlement', {
              sessionId: event.data.object.id,
              paymentStatus: event.data.object.payment_status,
            });
            break;
          }

          const result = await paymentService.fulfillCheckoutSession(event.data.object);
          logger.info('checkout completed', result);
          break;
        }

        // This one means the money settled, unlike completed-with-unpaid above.
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
