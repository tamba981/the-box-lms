'use strict';

const { z } = require('zod');

const { email, name } = require('./auth');
const { CONTACT_REASONS } = require('../lib/constants');

/**
 * Contact form input.
 *
 * The email and name rules are the ones sign-up uses, imported rather than
 * restated, so what counts as a valid address is decided in one place. The length
 * caps are deliberately generous — this is the one place a stranger can write to
 * the academy, and refusing a long message because of an arbitrary limit is worse
 * than storing a few extra kilobytes.
 */
const contactBody = z.object({
  name,
  email,
  reason: z.enum(CONTACT_REASONS).optional().default('general'),
  subject: z
    .string({ required_error: 'A subject is required' })
    .trim()
    .min(3, 'Add a short subject')
    .max(160, 'That subject is too long'),
  message: z
    .string({ required_error: 'A message is required' })
    .trim()
    .min(10, 'Tell us a little more than that')
    .max(4000, 'That message is too long'),
});

module.exports = { contactBody };
