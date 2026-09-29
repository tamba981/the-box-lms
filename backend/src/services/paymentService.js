'use strict';

const crypto = require('crypto');

const config = require('../config/env');
const logger = require('../lib/logger');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');

const enrollmentService = require('./enrollmentService');
const notifications = require('./notificationService');
const email = require('./email');
const { badRequest, unavailable } = require('../lib/errors');

/**
 * Stripe integration.
 *
 * Implemented against Stripe's HTTPS API directly rather than through the SDK:
 * the surface used here is two calls and one signature check, and the SDK would
 * be a large dependency for a feature that is disabled until keys are supplied.
 *
 * Everything money-related is idempotent. A webhook may be delivered more than
 * once, and a student may click Pay twice; neither may produce two payments or
 * two enrollments.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/** Webhook signatures older than this are rejected as replays. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

function assertConfigured() {
  if (!config.stripe.enabled) {
    throw unavailable(
      'Card payments are not configured on this deployment. Please contact the academy to enroll.',
      { code: 'PAYMENTS_DISABLED' }
    );
  }
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

/**
 * Create a Stripe Checkout Session for a course.
 *
 * The price is read from the course document, never from the request, so a
 * caller cannot choose what to pay.
 */
async function createCheckoutSession({ user, course }) {
  /**
   * Check the request before the deployment. Whether this course is free is a
   * property of the course, and reporting it is more useful than reporting that
   * the platform has no payment keys — the caller has a bug either way, but
   * this one they can act on.
   */
  if (course.priceCents <= 0) {
    throw badRequest('This course is free — just enroll directly.', { code: 'COURSE_IS_FREE' });
  }

  assertConfigured();

  // One payment record per (student, course) attempt. A repeated checkout
  // reuses the pending record instead of creating a second one.
  const idempotencyKey = `enroll:${String(user._id)}:${String(course._id)}`;

  let payment = await Payment.findOne({ idempotencyKey, status: { $in: ['pending', 'paid'] } });

  if (payment && payment.status === 'paid') {
    throw badRequest('You have already paid for this course.', { code: 'ALREADY_PAID' });
  }

  if (!payment) {
    payment = await Payment.create({
      student: user._id,
      course: course._id,
      amountCents: course.priceCents,
      currency: course.currency,
      provider: 'stripe',
      status: 'pending',
      idempotencyKey,
    });
  }

  const successUrl = `${config.publicBaseUrl}/student-dashboard.html#/course/${course.slug || course._id}?payment=success`;
  const cancelUrl = `${config.publicBaseUrl}/student-dashboard.html#/course/${course.slug || course._id}?payment=cancelled`;

  const form = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(payment._id),
    'metadata[paymentId]': String(payment._id),
    'metadata[studentId]': String(user._id),
    'metadata[courseId]': String(course._id),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': course.currency,
    'line_items[0][price_data][unit_amount]': String(course.priceCents),
    'line_items[0][price_data][product_data][name]': course.title,
  });

  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe honours this header, so a retried request cannot open two
      // sessions for the same payment record.
      'Idempotency-Key': `checkout:${String(payment._id)}`,
    },
    body: form.toString(),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    logger.error('stripe checkout session failed', { status: response.status, error: payload.error?.message });
    payment.failureReason = payload.error?.message || 'Checkout session could not be created';
    await payment.save();

    throw badRequest('We could not start the checkout. Please try again in a moment.', {
      code: 'CHECKOUT_FAILED',
    });
  }

  payment.providerSessionId = payload.id;
  payment.checkoutUrl = payload.url;
  await payment.save();

  return { payment, checkoutUrl: payload.url, sessionId: payload.id };
}

/* ------------------------------------------------------------------ *
 * Webhook signature verification
 * ------------------------------------------------------------------ */

/**
 * Verify the `Stripe-Signature` header.
 *
 * Stripe signs `${timestamp}.${rawBody}` with the endpoint's signing secret.
 * Both parts of the check matter: the HMAC proves the payload came from Stripe,
 * and the timestamp window stops an attacker replaying a captured, correctly
 * signed body indefinitely.
 *
 * `rawBody` must be the exact bytes Stripe sent — re-serialised JSON will not
 * match.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return { valid: false, reason: 'webhook_secret_missing' };
  if (!signatureHeader) return { valid: false, reason: 'signature_missing' };

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((piece) => {
        const [key, value] = piece.split('=');
        return [key?.trim(), value?.trim()];
      })
  );

  const timestamp = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'timestamp_missing' };

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const provided = parts.v1;
  if (!provided || provided.length !== expected.length) return { valid: false, reason: 'signature_mismatch' };

  const matches = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  return matches ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

/* ------------------------------------------------------------------ *
 * Webhook handling
 * ------------------------------------------------------------------ */

/**
 * Grant access after a completed checkout.
 *
 * Called from the webhook rather than from the browser redirect, because the
 * redirect can be abandoned, spoofed, or simply never happen — the webhook is
 * the only signal that money actually moved.
 */
async function fulfillCheckoutSession(session) {
  const paymentId = session.metadata?.paymentId || session.client_reference_id;

  const payment = paymentId
    ? await Payment.findById(paymentId)
    : await Payment.findOne({ providerSessionId: session.id });

  if (!payment) {
    logger.error('webhook for an unknown payment', { sessionId: session.id });
    return { handled: false, reason: 'payment_not_found' };
  }

  // Already done. A repeated delivery stops here.
  if (payment.status === 'paid' && payment.enrollment) {
    return { handled: true, reason: 'already_fulfilled', paymentId: String(payment._id) };
  }

  const [student, course] = await Promise.all([
    User.findById(payment.student),
    Course.findById(payment.course),
  ]);

  if (!student || !course) {
    logger.error('cannot fulfil payment: student or course missing', {
      paymentId: String(payment._id),
    });
    return { handled: false, reason: 'missing_entities' };
  }

  payment.status = 'paid';
  payment.paidAt = new Date();
  payment.providerPaymentIntentId = session.payment_intent || null;
  await payment.save();

  const { enrollment, created: isNew } = await enrollmentService.enroll({
    user: student,
    course,
    source: 'stripe',
    payment,
  });

  payment.enrollment = enrollment._id;
  await payment.save();

  if (isNew) {
    notifications
      .onPayment(student._id, payment, course, enrollmentService.courseLink(course))
      .catch(() => {});

    setImmediate(async () => {
      try {
        await email.deliver(
          email.paymentReceiptEmail({
            user: student,
            course,
            payment,
            nextUrl: enrollmentService.courseLink(course),
          })
        );
      } catch (error) {
        logger.error('receipt email failed', { error });
      }
    });
  }

  logger.info('payment fulfilled', {
    paymentId: String(payment._id),
    studentId: String(student._id),
    courseId: String(course._id),
    amountCents: payment.amountCents,
  });

  return { handled: true, reason: 'fulfilled', paymentId: String(payment._id), enrollmentId: String(enrollment._id) };
}

async function markFailed(session, reason) {
  const paymentId = session?.metadata?.paymentId || session?.client_reference_id;
  if (!paymentId) return null;

  return Payment.findOneAndUpdate(
    { _id: paymentId, status: { $ne: 'paid' } },
    { $set: { status: 'failed', failureReason: reason || 'Checkout did not complete' } },
    { new: true }
  );
}

module.exports = {
  assertConfigured,
  createCheckoutSession,
  verifyWebhookSignature,
  fulfillCheckoutSession,
  markFailed,
  SIGNATURE_TOLERANCE_SECONDS,
};
