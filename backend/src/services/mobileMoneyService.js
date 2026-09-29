'use strict';

const crypto = require('crypto');

const config = require('../config/env');
const logger = require('../lib/logger');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');

const paymentService = require('./paymentService');

const { badRequest, unavailable } = require('../lib/errors');

/**
 * Mobile money — Orange Money Liberia and Lonestar Cell MTN MoMo.
 *
 * What is real here: provider registration, availability reporting, phone
 * normalisation, the callback signature check, and settlement through the same
 * idempotent path Stripe uses. Those are the parts that decide whether money is
 * recorded correctly, and they are covered by the test suite.
 *
 * What is deliberately not written: the two HTTP calls to the providers. I do not
 * have their API documentation, and inventing an endpoint shape or an
 * authentication scheme would produce code that looks finished and fails in
 * production against real money. `requestChargeFromProvider` below therefore
 * throws rather than guessing. Supply the documentation and each provider needs
 * one function filled in — nothing else in this file changes.
 *
 * Callback scheme: the endpoint expects a shared secret signed the same way
 * Stripe signs its webhooks — `t=<unix>,v1=<hmac_sha256(secret, "t.body")>` — with
 * a five-minute window. If a provider uses its own scheme (most send a bearer
 * token or a second shared secret instead), replace `verifyCallback` with theirs.
 * Do not remove it: an unauthenticated callback endpoint can be used to grant
 * free enrolments by anyone who learns the URL.
 */

const CALLBACK_TOLERANCE_SECONDS = 300;

function listProviders() {
  return config.mobileMoney.map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    currency: provider.currency,
    phoneHint: provider.phoneHint,
    enabled: provider.configured,
    // Naming what is absent is actionable; "not configured" is not.
    missing: provider.missing,
  }));
}

function getProvider(id) {
  return config.mobileMoney.find((provider) => provider.id === id) || null;
}

function assertConfigured(provider) {
  if (!provider) {
    throw badRequest('That payment method is not recognised.', { code: 'UNKNOWN_PAYMENT_METHOD' });
  }

  if (!provider.configured) {
    throw unavailable(
      `${provider.label} is not available yet. Please use another method or contact the academy.`,
      {
        code: 'PROVIDER_NOT_CONFIGURED',
        details: provider.missing.map((name) => ({
          field: name,
          message: `${name} is not set on this deployment`,
        })),
      }
    );
  }
}

/**
 * Normalise a Liberian mobile number to E.164 (`+231XXXXXXXX`).
 *
 * Deliberately does not guess which network a number belongs to. Prefix-to-
 * network rules change and getting them wrong would send a payment prompt to the
 * wrong network; the provider is the authority on whether a number is theirs.
 */
function normalisePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  if (!digits) throw badRequest('Enter the mobile money number to charge.', { code: 'PHONE_REQUIRED' });

  const withoutPlus = digits.replace(/^\+/, '');
  const national = withoutPlus.startsWith('231') ? withoutPlus.slice(3) : withoutPlus;
  const trimmed = national.replace(/^0+/, '');

  if (!/^\d{7,9}$/.test(trimmed)) {
    throw badRequest('That does not look like a Liberian mobile number.', {
      code: 'PHONE_INVALID',
      details: [{ field: 'phoneNumber', message: 'Use the format 0771234567 or +231771234567' }],
    });
  }

  return `+231${trimmed}`;
}

/* ------------------------------------------------------------------ *
 * The provider call — the one part that needs their documentation
 * ------------------------------------------------------------------ */

/**
 * Ask the provider to charge the payer.
 *
 * Must return `{ reference }` — the provider's transaction identifier — and may
 * return `{ instructions }`, a short sentence to show the payer (most mobile
 * money flows tell them to approve a prompt on their handset).
 *
 * It must also be idempotent on our side: use `payment._id` as the merchant
 * reference so a retried request cannot open two charges.
 */
async function requestChargeFromProvider({ provider, payment, phoneNumber, course }) {
  switch (provider.id) {
    case 'orange_money':
      return requestOrangeMoneyCharge({ provider, payment, phoneNumber, course });
    case 'lonestar_momo':
      return requestLonestarMomoCharge({ provider, payment, phoneNumber, course });
    default:
      throw badRequest('That payment method is not recognised.', { code: 'UNKNOWN_PAYMENT_METHOD' });
  }
}

async function requestOrangeMoneyCharge() {
  // TODO(orange-money): implement against Orange Money Liberia's API documentation.
  //
  // Needs: the token/authentication flow, the charge endpoint, the required
  // merchant fields, and the shape of the success response (the transaction id
  // to store as `providerReference`).
  throw unavailable(
    'Orange Money is configured but its API has not been integrated yet. The charge was not taken.',
    { code: 'PROVIDER_NOT_IMPLEMENTED' }
  );
}

async function requestLonestarMomoCharge() {
  // TODO(lonestar-momo): implement against Lonestar Cell MTN MoMo API documentation.
  //
  // Same requirements as Orange Money above. If both providers turn out to expose
  // the same aggregator, these two functions collapse into one.
  throw unavailable(
    'Lonestar Cell MTN MoMo is configured but its API has not been integrated yet. The charge was not taken.',
    { code: 'PROVIDER_NOT_IMPLEMENTED' }
  );
}

/* ------------------------------------------------------------------ *
 * Initiation
 * ------------------------------------------------------------------ */

async function initiateCharge({ user, course, providerId, phoneNumber }) {
  const provider = getProvider(providerId);
  assertConfigured(provider);

  if (course.priceCents <= 0) {
    throw badRequest('This course is free — just enroll directly.', { code: 'COURSE_IS_FREE' });
  }

  const already = await Enrollment.findOne({
    student: user._id,
    course: course._id,
    status: { $ne: 'cancelled' },
  });

  if (already) {
    throw badRequest('You are already enrolled in this course.', { code: 'ALREADY_ENROLLED' });
  }

  const phone = normalisePhone(phoneNumber);
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
      provider: provider.id,
      method: 'mobile_money',
      payerPhone: phone,
      status: 'pending',
      idempotencyKey,
    });
  } else {
    // A pending record is reused, so make it describe this attempt.
    payment.provider = provider.id;
    payment.method = 'mobile_money';
    payment.payerPhone = phone;
    payment.amountCents = course.priceCents;
    payment.currency = course.currency;
    await payment.save();
  }

  try {
    const result = await requestChargeFromProvider({
      provider,
      payment,
      phoneNumber: phone,
      course,
    });

    payment.providerReference = result.reference || null;
    await payment.save();

    return {
      payment,
      instructions:
        result.instructions ||
        `Approve the ${provider.label} prompt on ${phone} to complete your enrolment.`,
    };
  } catch (error) {
    /**
     * The charge was not taken. Record why and tell the payer plainly rather than
     * leaving a pending payment that looks like money is on its way.
     */
    payment.status = 'failed';
    payment.failureReason = error.message || 'The charge could not be started';
    await payment.save();
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Callbacks
 * ------------------------------------------------------------------ */

/**
 * Verify a callback. Same construction as the Stripe webhook, so there is one
 * shape to reason about rather than two.
 */
function verifyCallback(provider, rawBody, signatureHeader) {
  if (!provider || !provider.callbackSecret) {
    return { valid: false, reason: 'callback_secret_missing' };
  }
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

  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > CALLBACK_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', provider.callbackSecret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const provided = parts.v1;
  if (!provided || provided.length !== expected.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  const matches = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  return matches ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

/**
 * Apply a verified callback.
 *
 * Expects a normalised payload. A provider's own field names must be mapped onto
 * this shape before it reaches here, so that the settlement rules stay in one
 * place rather than multiplying per provider.
 *
 *   { reference, status: 'paid' | 'failed', amountCents, currency, transactionId }
 */
async function processCallback(provider, payload) {
  const reference = payload.reference || payload.transactionId;
  const payment = reference
    ? await Payment.findOne({
        $or: [{ providerReference: reference }, { providerSessionId: reference }],
        provider: provider.id,
      })
    : null;

  if (!payment) {
    logger.error('callback for an unknown payment', { provider: provider.id, reference });
    return { handled: false, reason: 'payment_not_found' };
  }

  if (payload.status !== 'paid') {
    if (payment.status !== 'paid') {
      payment.status = 'failed';
      payment.failureReason = payload.reason || `${provider.label} reported the payment as ${payload.status}`;
      await payment.save();
    }
    return { handled: true, reason: 'marked_failed', paymentId: String(payment._id) };
  }

  return paymentService.settlePayment(payment, {
    amountCents: payload.amountCents,
    currency: payload.currency,
    providerReference: payload.transactionId || reference,
  });
}

module.exports = {
  CALLBACK_TOLERANCE_SECONDS,
  assertConfigured,
  getProvider,
  initiateCharge,
  listProviders,
  normalisePhone,
  processCallback,
  verifyCallback,
};
