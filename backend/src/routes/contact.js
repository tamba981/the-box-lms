'use strict';

const express = require('express');

const ContactMessage = require('../models/ContactMessage');

const config = require('../config/env');
const email = require('../services/email');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/contact');

const router = express.Router();

/**
 * POST /api/v1/contact
 *
 * Open to anyone: this is how somebody with a problem reaches a person without
 * holding an account, which is exactly when they are most likely to need to.
 *
 * Stored first, notified second. The order matters — if the mail provider is down
 * or unconfigured, the message still exists and can be found, whereas sending
 * first and storing on success would discard what a person wrote because a third
 * party had a bad minute.
 */
router.post(
  '/',
  writeLimiter,
  validate({ body: schemas.contactBody }),
  asyncHandler(async (req, res) => {
    const { name, email: address, reason, subject, message } = req.valid.body;

    const stored = await ContactMessage.create({ name, email: address, reason, subject, message });

    try {
      const result = await email.deliver(
        email.contactMessageEmail({
          name,
          email: address,
          reason,
          subject,
          message,
          inbox: config.email.inbox,
        })
      );

      /**
       * `deliver` reports failure rather than throwing — with no provider
       * configured it returns `{ delivered: false }` and writes the message to the
       * log. So the result has to be read, not assumed: setting this after the
       * call would record that somebody had been told when nothing was sent, which
       * is precisely the lie the field exists to prevent.
       */
      if (result && result.delivered) {
        stored.notifiedAt = new Date();
        await stored.save();
      } else {
        logger.warn('contact message stored but nobody was notified', {
          contactMessageId: String(stored._id),
          reason: (result && result.reason) || 'unknown',
        });
      }
    } catch (error) {
      /**
       * Swallowed on purpose, and recorded. The person's message has been saved;
       * failing the request now would tell them it was not received when it was,
       * and invite them to send it again.
       */
      logger.error('contact notification threw', {
        error,
        contactMessageId: String(stored._id),
        inbox: config.email.inbox,
      });
    }

    return ok(res, null, "We've received your message.");
  })
);

module.exports = router;
