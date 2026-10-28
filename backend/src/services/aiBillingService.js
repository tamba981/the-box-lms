'use strict';

/**
 * Buying AI credits.
 *
 * A student with no allowance — because every course they are in is completely
 * free — buys a bundle the same way they pay for a course: mobile money, a
 * reference, a person checking the account. The academy already runs that flow by
 * hand, so this reuses its shape rather than inventing a second one.
 *
 * Nothing here grants credits on the student's word. `POST /bundle/:id/sent` only
 * records that they say they paid; the credits land when an administrator
 * confirms, which is the only moment money and entitlement are known to agree.
 * That is also why the amount and credit count are copied onto the order when it
 * is opened: changing the price later must not change what somebody already owes.
 */

const config = require('../config/env');
const aiService = require('./aiService');
const AICreditOrder = require('../models/AICreditOrder');
const User = require('../models/User');
const email = require('./email');
const logger = require('../lib/logger');
const { badRequest, forbidden, notFound, unavailable } = require('../lib/errors');

/** What a bundle costs and how to pay it, for the panel to render. */
function bundleOffer() {
  const numbers = config.manualPayment.numbers || [];

  return {
    credits: config.ai.bundle.credits,
    amountCents: config.ai.bundle.priceCents,
    currency: config.ai.bundle.currency,
    numbers,
    payTo: config.manualPayment.payTo,
    expiryDays: config.ai.bundle.expiryDays,
    // Without a destination there is nothing to tell the student to do, and an
    // order they cannot pay is worse than a clear "not available".
    available: numbers.length > 0 && config.ai.bundle.priceCents > 0,
    steps: [
      'Send the exact amount to one of the numbers below.',
      'Use the reference we give you as the payment reference.',
      'Press "I have sent the payment" so an administrator knows to look for it.',
    ],
  };
}

/**
 * Open an order, or hand back the one already open.
 *
 * Reusing an open order rather than stacking a second is the same rule the course
 * checkout follows: two references for one intended payment is two things for an
 * administrator to reconcile and one likely double charge.
 */
async function createOrder({ user, payerPhone = null }) {
  aiService.assertEnabled();

  const offer = bundleOffer();
  if (!offer.available) {
    throw unavailable(
      'Buying credits is not available on this deployment yet. Please contact the academy.',
      { code: 'AI_BUNDLE_UNAVAILABLE' }
    );
  }

  const open = await AICreditOrder.findOne({
    student: user._id,
    status: { $in: ['pending', 'awaiting_verification'] },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (open) return { order: open, reused: true };

  const now = Date.now();

  // A reference is six characters from a 32-symbol alphabet, so a collision is
  // vanishingly unlikely — but retrying costs nothing and a unique index that
  // fires would fail the student's purchase for no reason.
  let order = null;
  for (let attempt = 0; attempt < 5 && !order; attempt += 1) {
    try {
      order = await AICreditOrder.create({
        student: user._id,
        credits: offer.credits,
        amountCents: offer.amountCents,
        currency: offer.currency,
        reference: AICreditOrder.newReference(),
        payerPhone,
        expiresAt: new Date(now + offer.expiryDays * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      if (error && error.code === 11000) continue;
      throw error;
    }
  }

  if (!order) {
    throw unavailable('Could not open an order just now. Please try again.', {
      code: 'AI_ORDER_FAILED',
    });
  }

  logger.info('ai credit order created', {
    reference: order.reference,
    studentId: String(user._id),
    credits: order.credits,
    amountCents: order.amountCents,
  });

  return { order, reused: false };
}

/** "I have sent the payment" — a claim, recorded, nothing more. */
async function markSent({ user, orderId, payerPhone = null }) {
  const order = await AICreditOrder.findById(orderId);
  if (!order) throw notFound('That order could not be found.', { code: 'AI_ORDER_NOT_FOUND' });

  if (String(order.student) !== String(user._id)) {
    throw forbidden('That order is not yours.', { code: 'NOT_YOUR_ORDER' });
  }

  if (order.status === 'paid') return { order, alreadyPaid: true };
  if (order.status === 'rejected') {
    throw badRequest('That order was declined. Start a new one if you still want credits.', {
      code: 'ORDER_REJECTED',
    });
  }

  order.status = 'awaiting_verification';
  order.submittedAt = new Date();
  if (payerPhone) order.payerPhone = payerPhone;
  await order.save();

  return { order, alreadyPaid: false };
}

async function listMine({ user }) {
  const orders = await AICreditOrder.find({ student: user._id })
    .sort({ createdAt: -1 })
    .limit(20);

  return orders.map((order) => order.toStudentJSON());
}

/**
 * The academy's side: the money is in the account, so add the credits.
 *
 * Idempotent, because a double click on Confirm in the admin queue must not buy
 * 1000 credits: `creditsGranted` is the record of what has actually been added,
 * and it is written in the same update that moves the status to paid.
 */
async function confirmOrder({ order, adminUser = null, notes = null }) {
  if (order.status === 'paid' && order.creditsGranted > 0) {
    return { order, granted: 0, alreadyDone: true };
  }

  if (order.status === 'rejected') {
    throw badRequest('That order was declined and cannot be confirmed.', { code: 'ORDER_REJECTED' });
  }

  const claimed = await AICreditOrder.findOneAndUpdate(
    { _id: order._id, status: { $ne: 'paid' } },
    {
      $set: {
        status: 'paid',
        verifiedAt: new Date(),
        verifiedBy: adminUser ? adminUser._id : null,
        creditsGranted: order.credits,
        ...(notes ? { notes } : {}),
      },
    },
    { new: true }
  );

  if (!claimed) {
    // Another administrator got there first between the read and the write.
    return { order, granted: 0, alreadyDone: true };
  }

  await User.updateOne(
    { _id: claimed.student },
    { $inc: { 'aiCredits.bonus': claimed.credits } }
  );

  logger.info('ai credit order confirmed', {
    reference: claimed.reference,
    studentId: String(claimed.student),
    credits: claimed.credits,
    by: adminUser ? String(adminUser._id) : null,
  });

  const student = await User.findById(claimed.student).select('firstName lastName email');

  if (student) {
    setImmediate(async () => {
      try {
        await email.deliver(email.aiCreditsAddedEmail({ user: student, order: claimed }));
      } catch (error) {
        logger.error('ai credits email failed', { reference: claimed.reference, error });
      }
    });
  }

  return { order: claimed, granted: claimed.credits, alreadyDone: false };
}

async function rejectOrder({ order, adminUser = null, reason }) {
  if (order.status === 'paid') {
    throw badRequest('That order has already been confirmed.', { code: 'ORDER_ALREADY_PAID' });
  }

  order.status = 'rejected';
  order.rejectedAt = new Date();
  order.rejectionReason = reason;
  order.verifiedBy = adminUser ? adminUser._id : null;
  await order.save();

  logger.info('ai credit order rejected', { reference: order.reference, reason });

  return order;
}

module.exports = {
  bundleOffer,
  createOrder,
  markSent,
  listMine,
  confirmOrder,
  rejectOrder,
};
