'use strict';

const crypto = require('crypto');

const config = require('../config/env');
const logger = require('../lib/logger');
const { newOrderId } = require('../lib/orderId');
const Certificate = require('../models/Certificate');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');

const certificateService = require('./certificateService');
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
  } else if (payment.amountCents !== course.priceCents || payment.currency !== course.currency) {
    /**
     * A pending record is reused across attempts, and the price is read fresh
     * each time. If the instructor changed it in between, the record would
     * describe an amount Stripe is not going to charge — and the revenue
     * reports would be wrong by whatever the difference was. Bring the record
     * back in line with the price the student is actually being asked to pay.
     */
    logger.info('course price changed between checkout attempts', {
      paymentId: String(payment._id),
      was: `${payment.amountCents} ${payment.currency}`,
      now: `${course.priceCents} ${course.currency}`,
    });

    payment.amountCents = course.priceCents;
    payment.currency = course.currency;
    await payment.save();
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

  return settlePayment(payment, {
    amountCents: session.amount_total,
    currency: session.currency,
    providerPaymentIntentId: session.payment_intent || null,
  });
}

/**
 * The one place a payment becomes an enrolment, whatever moved the money.
 *
 * Stripe and the mobile-money providers arrive here by different routes, and
 * they must not be allowed to diverge. A second copy of this logic would
 * eventually disagree with the first about idempotency or about what counts as
 * settled, and the disagreement would stay invisible until it cost someone a
 * course, a refund, or a duplicated enrolment.
 */
async function settlePayment(
  payment,
  { amountCents, currency, providerPaymentIntentId = null, providerReference = null, paidAt = null } = {}
) {
  const purpose = payment.purpose || 'enrollment';

  /**
   * Already settled. A repeated delivery stops here.
   *
   * What "settled" means depends on what was bought: an enrollment payment has
   * an enrollment, a certificate payment has a certificate it settled. This
   * guard read `payment.enrollment` only, and a certificate payment has none —
   * so a re-delivered callback would have run the second half of this function
   * again.
   */
  const alreadySettled =
    payment.status === 'paid' &&
    (purpose === 'certificate' ? Boolean(payment.certificate) : Boolean(payment.enrollment));

  if (alreadySettled) {
    return { handled: true, reason: 'already_fulfilled', paymentId: String(payment._id) };
  }

  /**
   * Confirm the provider took what this record expects.
   *
   * The record is the source of truth for revenue reporting, and the two can
   * drift — a price change mid-checkout, a charge built from an older record, or
   * a callback that did not originate from us at all. Refusing leaves the payment
   * pending for a person to look at, which is much better than granting access
   * and recording a figure that never happened.
   */
  if (typeof amountCents === 'number' && amountCents !== payment.amountCents) {
    logger.error('refusing to settle: amount does not match the payment record', {
      paymentId: String(payment._id),
      expected: payment.amountCents,
      charged: amountCents,
    });
    return { handled: false, reason: 'amount_mismatch', paymentId: String(payment._id) };
  }

  if (currency && String(currency).toLowerCase() !== String(payment.currency).toLowerCase()) {
    logger.error('refusing to settle: currency does not match the payment record', {
      paymentId: String(payment._id),
      expected: payment.currency,
      charged: currency,
    });
    return { handled: false, reason: 'currency_mismatch', paymentId: String(payment._id) };
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

  /**
   * A certificate payment awards a document; it must not enrol anybody. The
   * student is already enrolled — that is what made them eligible to finish the
   * course and become liable for the fee in the first place.
   */
  if (purpose === 'certificate') {
    return fulfilCertificatePayment({
      payment,
      student,
      course,
      providerPaymentIntentId,
      providerReference,
      paidAt,
    });
  }

  payment.status = 'paid';
  payment.paidAt = paidAt || new Date();
  if (providerPaymentIntentId) payment.providerPaymentIntentId = providerPaymentIntentId;
  if (providerReference) payment.providerReference = providerReference;
  await payment.save();

  const { enrollment, created: isNew } = await enrollmentService.enroll({
    user: student,
    course,
    // Who took the money, so an enrolment is traceable back to its payment path.
    source:
      payment.provider === 'manual'
        ? 'manual'
        : payment.method === 'mobile_money'
          ? 'mobile_money'
          : 'stripe',
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

/**
 * Award the certificate a confirmed payment bought.
 *
 * The student is already enrolled and has already finished; what is being bought
 * here is the document. So this path awards a certificate and must never create
 * an enrollment — doing both would put a second enrollment in the table for a
 * course the student has had for weeks.
 *
 * Reached only through `settlePayment`, after the same amount and currency checks
 * the enrollment path goes through.
 */
async function fulfilCertificatePayment({
  payment,
  student,
  course,
  providerPaymentIntentId = null,
  providerReference = null,
  paidAt = null,
}) {
  const certificate = payment.certificate ? await Certificate.findById(payment.certificate) : null;

  if (!certificate) {
    logger.error('cannot fulfil certificate payment: the certificate is missing', {
      paymentId: String(payment._id),
      certificateId: payment.certificate ? String(payment.certificate) : null,
    });
    return { handled: false, reason: 'missing_certificate' };
  }

  if (certificate.revokedAt) {
    logger.error('cannot fulfil certificate payment: the certificate was revoked', {
      paymentId: String(payment._id),
      certificateNumber: certificate.certificateNumber,
    });
    return { handled: false, reason: 'certificate_revoked' };
  }

  /**
   * The order was opened for this document at this price. Comparing the two is
   * what catches an order built against the wrong certificate — the provider's
   * figure was already checked against the record by the caller.
   */
  if ((certificate.feeCents || 0) !== payment.amountCents) {
    logger.error('refusing to issue: the certificate fee does not match the order', {
      paymentId: String(payment._id),
      certificateNumber: certificate.certificateNumber,
      feeCents: certificate.feeCents,
      orderCents: payment.amountCents,
    });
    return { handled: false, reason: 'fee_mismatch' };
  }

  payment.status = 'paid';
  payment.paidAt = paidAt || new Date();
  if (providerPaymentIntentId) payment.providerPaymentIntentId = providerPaymentIntentId;
  if (providerReference) payment.providerReference = providerReference;
  await payment.save();

  await certificateService.markPaid(certificate, payment);

  notifications
    .onCertificate(student._id, certificate, '/student-dashboard.html#/certificates')
    .catch((error) => logger.error('certificate notification failed', { error }));

  // The document, now that it exists. This is the same email the free path
  // sends; the student is being told the same thing, later.
  setImmediate(async () => {
    try {
      await email.deliver(email.certificateEmail({ user: student, certificate }));
    } catch (error) {
      logger.error('certificate email failed', { error });
    }
  });

  logger.info('certificate payment fulfilled', {
    paymentId: String(payment._id),
    certificateNumber: certificate.certificateNumber,
    studentId: String(student._id),
    courseId: String(course._id),
    amountCents: payment.amountCents,
  });

  return {
    handled: true,
    reason: 'fulfilled',
    paymentId: String(payment._id),
    certificateId: String(certificate._id),
    certificateNumber: certificate.certificateNumber,
  };
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

/* ------------------------------------------------------------------ *
 * Manual, offline orders
 * ------------------------------------------------------------------ */

/**
 * The offline path: the student is handed an order reference and the numbers to
 * send money to, and a person at the academy confirms it arrived.
 *
 * This exists because no automated gateway is open to a business registered in
 * Liberia, and because taking money by mobile money and confirming it by hand is
 * already how the academy operates. Nothing here moves funds. It records an
 * intention, then a person's confirmation of it.
 */

/**
 * One live order per student per course per five minutes.
 *
 * `idempotencyKey` is already unique on this collection, so the rate rule is
 * carried by the key instead of by a separate check that could race with itself.
 * The five-minute bucket means a double-tap on the button returns the same order,
 * while a student whose order was rejected can simply try again — the next bucket
 * is a different key, so no one is locked out of a course they still want.
 */
const MANUAL_ORDER_WINDOW_MS = 5 * 60 * 1000;

function manualIdempotencyKey(studentId, courseId, now, purpose = 'enrollment') {
  return `manual:${purpose}:${String(studentId)}:${String(courseId)}:${Math.floor(now / MANUAL_ORDER_WINDOW_MS)}`;
}

/** What the student is told to do, and where to send it. */
function manualInstructions() {
  return {
    numbers: config.manualPayment.numbers,
    expiryDays: config.manualPayment.expiryDays,
    steps: [
      'Send the exact amount to one of the numbers above.',
      'Use your order reference as the payment reference.',
      'Press "I have sent the payment" so we know to look for it.',
    ],
  };
}

async function createManualOrder({ user, course, purpose = 'enrollment', studentPhone = null }) {
  if (purpose === 'certificate') {
    return createManualCertificateOrder({ user, course, studentPhone });
  }

  if (course.priceCents <= 0) {
    throw badRequest('This course is free — just enroll directly.', { code: 'COURSE_IS_FREE' });
  }

  /**
   * Without a destination there is nothing to tell the student to do, and an
   * order they cannot pay is worse than a clear refusal.
   */
  if (!config.manualPayment.numbers.length) {
    throw unavailable(
      'No payment numbers are configured on this deployment, so a manual payment cannot be accepted. Please contact the academy.',
      { code: 'MANUAL_PAYMENT_UNAVAILABLE' }
    );
  }

  const now = Date.now();
  const idempotencyKey = manualIdempotencyKey(user._id, course._id, now);

  const existing = await Payment.findOne({ idempotencyKey });
  if (existing) return { payment: existing, reused: true };

  const payment = await Payment.create({
    student: user._id,
    course: course._id,
    amountCents: course.priceCents,
    currency: course.currency,
    provider: 'manual',
    method: 'mobile_money',
    status: 'pending',
    orderId: newOrderId(now),
    studentPhone,
    expiresAt: new Date(now + config.manualPayment.expiryDays * 24 * 60 * 60 * 1000),
    idempotencyKey,
  });

  logger.info('manual order created', {
    orderId: payment.orderId,
    studentId: String(user._id),
    courseId: String(course._id),
    amountCents: payment.amountCents,
  });

  return { payment, reused: false };
}

/**
 * Buy the certificate itself, on a course that was free to study.
 *
 * Nothing here trusts the request: the price is the one fixed on the certificate
 * when the student finished, the document is found from the enrolment, and an
 * order is only opened for a certificate that is actually waiting to be paid for.
 *
 * A student who has not finished is refused rather than allowed to pay in
 * advance — money taken for a course they might never complete is money that has
 * to be given back.
 */
async function createManualCertificateOrder({ user, course, studentPhone = null }) {
  const certificate = await Certificate.findOne({ student: user._id, course: course._id }).sort({
    issueDate: -1,
  });

  if (!certificate) {
    throw badRequest(
      'Finish every lesson in this course first — its certificate is only offered once the course is complete.',
      { code: 'COURSE_NOT_COMPLETED' }
    );
  }

  if (certificate.revokedAt || certificate.status === 'revoked') {
    throw badRequest('That certificate was revoked. Please contact the academy.', {
      code: 'CERTIFICATE_REVOKED',
    });
  }

  if ((certificate.status || 'issued') === 'issued') {
    throw badRequest('This certificate has already been issued — there is nothing to pay.', {
      code: 'CERTIFICATE_ALREADY_ISSUED',
    });
  }

  const feeCents = certificate.feeCents || 0;
  if (feeCents <= 0) {
    throw badRequest('This course does not charge for its certificate.', { code: 'NO_CERTIFICATE_FEE' });
  }

  if (!config.manualPayment.numbers.length) {
    throw unavailable(
      'No payment numbers are configured on this deployment, so a manual payment cannot be accepted. Please contact the academy.',
      { code: 'MANUAL_PAYMENT_UNAVAILABLE' }
    );
  }

  /**
   * An order already open for this certificate is handed back rather than a
   * second one being created. Unlike a course purchase, the student returns to
   * this button repeatedly from their dashboard, often days apart, and there is
   * nothing to be gained by making them start again — least of all a second
   * transfer of the same fee.
   */
  const openOrder = await Payment.findOne({
    student: user._id,
    course: course._id,
    purpose: 'certificate',
    status: { $in: ['pending', 'awaiting_verification'] },
  }).sort({ createdAt: -1 });

  if (openOrder && !openOrder.isExpired()) return { payment: openOrder, reused: true };

  const now = Date.now();
  const idempotencyKey = manualIdempotencyKey(user._id, course._id, now, 'certificate');

  const existing = await Payment.findOne({ idempotencyKey });
  if (existing) return { payment: existing, reused: true };

  const payment = await Payment.create({
    student: user._id,
    course: course._id,
    purpose: 'certificate',
    certificate: certificate._id,
    amountCents: feeCents,
    currency: certificate.currency || course.currency,
    provider: 'manual',
    method: 'mobile_money',
    status: 'pending',
    orderId: newOrderId(now),
    studentPhone,
    expiresAt: new Date(now + config.manualPayment.expiryDays * 24 * 60 * 60 * 1000),
    idempotencyKey,
  });

  logger.info('certificate order created', {
    orderId: payment.orderId,
    certificateNumber: certificate.certificateNumber,
    studentId: String(user._id),
    amountCents: payment.amountCents,
  });

  return { payment, reused: false };
}

/** Look an order up by the reference the student was given. */
async function findManualOrder(orderId) {
  return Payment.findOne({ orderId: String(orderId || '').trim().toUpperCase(), provider: 'manual' });
}

/**
 * The student's side of the confirmation: "I have sent it".
 *
 * This is a claim, not evidence, so it moves the order into the queue a person
 * works through rather than granting anything.
 */
async function markManualOrderPaid({ payment, paidToNumber = null, paymentReference = null }) {
  if (payment.status === 'paid') {
    throw badRequest('This order has already been confirmed.', { code: 'ORDER_ALREADY_PAID' });
  }

  if (payment.status === 'rejected') {
    throw badRequest('This order was declined. Please start a new one.', { code: 'ORDER_REJECTED' });
  }

  if (payment.isExpired()) {
    payment.status = 'expired';
    await payment.save();
    throw badRequest('This order has expired. Please start a new one.', { code: 'ORDER_EXPIRED' });
  }

  payment.markedPaidAt = payment.markedPaidAt || new Date();
  if (paidToNumber) payment.paidToNumber = paidToNumber;
  if (paymentReference) payment.paymentReference = paymentReference;
  payment.status = 'awaiting_verification';
  await payment.save();

  logger.info('manual order marked as sent', { orderId: payment.orderId });

  // The student has said they paid. Tell them it arrived, so the silence that
  // follows a manual transfer does not read as "nothing happened".
  setImmediate(async () => {
    try {
      const [student, course] = await Promise.all([
        User.findById(payment.student),
        Course.findById(payment.course).select('title slug'),
      ]);

      if (student) {
        await email.deliver(
          email.manualPaymentSubmittedEmail({
            user: student,
            /**
             * The course, actually loaded.
             *
             * This used to pass `payment.courseTitle`, a field the Payment model
             * has never had, so every one of these emails said the payment for
             * "undefined" had been sent.
             */
            course: course || { title: 'your course' },
            payment,
          })
        );
      }
    } catch (error) {
      logger.error('manual payment submitted email failed', { error, orderId: payment.orderId });
    }
  });

  return { payment };
}

/**
 * The academy's side: the money is in the account, so grant access.
 *
 * Handing this to `settlePayment` rather than enrolling here is the whole point
 * of that function existing. A second copy of "mark paid, enrol, notify, receipt"
 * would eventually disagree with the first about idempotency, and that
 * disagreement would stay invisible until it cost somebody a course or a
 * duplicated enrolment.
 */
async function confirmManualOrder({ payment, adminUser = null, notes = null }) {
  const purpose = payment.purpose || 'enrollment';
  const alreadyDone =
    payment.status === 'paid' &&
    (purpose === 'certificate' ? Boolean(payment.certificate) : Boolean(payment.enrollment));

  if (alreadyDone) {
    return { handled: true, reason: 'already_fulfilled', paymentId: String(payment._id) };
  }

  if (payment.status === 'rejected') {
    throw badRequest('This order was declined and cannot be confirmed.', { code: 'ORDER_REJECTED' });
  }

  payment.verifiedAt = new Date();
  payment.verifiedBy = adminUser ? adminUser._id : null;
  if (notes) payment.notes = notes;
  await payment.save();

  /**
   * Close every other live order for the same purchase.
   *
   * A student can have a card checkout open and a manual order on the go at the
   * same time. Once one of them has been settled, leaving the other queued would
   * put an order in front of an administrator for a course the student already
   * has, and invite a second confirmation for money that was never sent twice.
   */
  const supersededPurpose =
    (payment.purpose || 'enrollment') === 'enrollment'
      ? // Orders created before `purpose` existed carry no value at all, and a
        // filter on `purpose: 'enrollment'` would leave them open for ever.
        { $or: [{ purpose: 'enrollment' }, { purpose: { $exists: false } }] }
      : { purpose: 'certificate' };

  await Payment.updateMany(
    {
      _id: { $ne: payment._id },
      student: payment.student,
      course: payment.course,
      // Only orders for the same product. Confirming a certificate payment must
      // not silently expire an enrolment order somebody else is waiting on.
      ...supersededPurpose,
      status: { $in: ['pending', 'awaiting_verification'] },
    },
    { $set: { status: 'expired', failureReason: 'Superseded by a confirmed order' } }
  );

  return settlePayment(payment, { paidAt: new Date() });
}

async function rejectManualOrder({ payment, adminUser = null, reason }) {
  if (payment.status === 'paid') {
    throw badRequest('This order has already been confirmed.', { code: 'ORDER_ALREADY_PAID' });
  }

  payment.status = 'rejected';
  payment.rejectedAt = new Date();
  payment.rejectionReason = reason;
  payment.verifiedBy = adminUser ? adminUser._id : null;
  await payment.save();

  logger.info('manual order rejected', { orderId: payment.orderId, reason });

  // The alternative is a student refreshing a dashboard wondering why nothing
  // opened. The reason is included because it is the only actionable part.
  setImmediate(async () => {
    try {
      const student = await User.findById(payment.student);
      if (student) {
        await email.deliver(
          email.manualPaymentRejectedEmail({
            user: student,
            course: { title: payment.courseTitle },
            payment,
            reason,
          })
        );
      }
    } catch (error) {
      logger.error('manual payment rejected email failed', { error, orderId: payment.orderId });
    }
  });

  return { payment };
}

module.exports = {
  assertConfigured,
  createCheckoutSession,
  verifyWebhookSignature,
  fulfillCheckoutSession,
  settlePayment,
  markFailed,
  createManualOrder,
  findManualOrder,
  markManualOrderPaid,
  confirmManualOrder,
  rejectManualOrder,
  manualInstructions,
  MANUAL_ORDER_WINDOW_MS,
  SIGNATURE_TOLERANCE_SECONDS,
};
