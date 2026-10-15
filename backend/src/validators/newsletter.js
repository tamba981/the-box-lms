'use strict';

const { z } = require('zod');

const { email } = require('./auth');

/**
 * Newsletter input.
 *
 * The email rule is imported from the auth validators rather than restated, so an
 * address accepted here is accepted by sign-up and password reset too, and a
 * change to what "valid" means happens in one place. It already trims and
 * lowercases, which is what the unique index relies on.
 */
const subscribeBody = z.object({
  email,
  source: z.string().trim().toLowerCase().max(40).optional(),
});

module.exports = { subscribeBody };
