'use strict';

const express = require('express');

const BusinessLead = require('../models/BusinessLead');

const config = require('../config/env');
const mailer = require('../services/email');
const logger = require('../lib/logger');

const { asyncHandler } = require('../lib/asyncHandler');
const { created } = require('../lib/respond');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/business');

const router = express.Router();

/**
 * POST /api/v1/business/enquiries
 *
 * The enquiry form on /business.html, /universities.html and /government.html.
 * Open to anyone, because those pages are public.
 *
 * Order matters: the lead is stored first and the notification is attempted
 * afterwards. If Resend is down the enquiry is still in the database, which is
 * the outcome that matters - the person typed it once and should not have to
 * type it again because an email provider had a bad minute.
 *
 * The response says the enquiry was received and when to expect a reply. It
 * does not echo anything back, so the endpoint cannot be used to confirm whether
 * a given address has written to us before.
 */
router.post(
  '/enquiries',
  writeLimiter,
  validate({ body: schemas.enquiryBody }),
  asyncHandler(async (req, res) => {
    const body = req.valid.body;

    const lead = await BusinessLead.create({
      company: body.company,
      contactName: body.contactName,
      email: body.email,
      phone: body.phone,
      audience: body.audience,
      teamSize: body.teamSize,
      timeline: body.timeline,
      interests: body.interests,
      message: body.message,
    });

    try {
      const message = mailer.businessEnquiryEmail({ lead: lead.toAdminJSON() });
      const result = await mailer.deliver(message);

      if (result && result.delivered) {
        lead.notifiedAt = new Date();
        await lead.save();
      } else {
        // Not an error: with no API key configured, `deliver` reports that the
        // message was not sent and the lead stays in the database.
        logger.info('business enquiry stored without email', { id: String(lead._id) });
      }
    } catch (error) {
      logger.error('business enquiry notification failed', {
        id: String(lead._id),
        message: error.message,
      });
    }

    return created(
      res,
      {
        message:
          'Thank you - your enquiry has reached our partnerships team. We reply within 2 business days.',
        reference: String(lead._id).slice(-8).toUpperCase(),
      },
      'Enquiry received'
    );
  })
);

module.exports = router;
