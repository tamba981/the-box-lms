'use strict';

const express = require('express');

const NewsletterSubscriber = require('../models/NewsletterSubscriber');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/newsletter');

const router = express.Router();

/**
 * POST /api/v1/newsletter/subscribe
 *
 * Open to anyone, because the form sits on the public homepage.
 *
 * The answer is identical whether the address was new or already on the list.
 * Two reasons, and the second is the one that matters: it is what the person
 * needs to know — they are on the list — and a different answer for a known
 * address would turn this endpoint into a way to ask whether a particular person
 * is a subscriber. That is a fact about them, and an anonymous caller should not
 * be able to extract it.
 */
router.post(
  '/subscribe',
  writeLimiter,
  validate({ body: schemas.subscribeBody }),
  asyncHandler(async (req, res) => {
    const { email, source } = req.valid.body;

    let subscriber = null;

    try {
      /**
       * Upsert rather than find-then-create. Two submits arriving together — a
       * double-click on a slow connection is the ordinary case, not the exotic
       * one — would otherwise both find nothing and both insert, and the second
       * would fail on the unique index and surface as a 500 for doing exactly
       * what the person asked.
       */
      subscriber = await NewsletterSubscriber.findOneAndUpdate(
        { email },
        { $setOnInsert: { email, source: source || 'index' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      // Even with an upsert, two requests can race as far as the index. The
      // address is on the list either way, which is the only thing the caller
      // was asking for.
      if (!error || error.code !== 11000) throw error;
      subscriber = await NewsletterSubscriber.findOne({ email });
    }

    /**
     * Re-subscribing after opting out is a new decision, so the existing row is
     * revived rather than a second one created — otherwise the address would sit
     * in the list twice, once live and once withdrawn.
     */
    if (subscriber && subscriber.unsubscribedAt) {
      subscriber.unsubscribedAt = null;
      subscriber.subscribedAt = new Date();
      await subscriber.save();
    }

    return ok(res, null, "Thanks! You're subscribed.");
  })
);

module.exports = router;
