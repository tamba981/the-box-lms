'use strict';

const { z } = require('zod');

/**
 * The one-time code issued by the OAuth callback.
 *
 * The exchange takes nothing else: the account is looked up from the token, so
 * there is no field here through which a caller could choose who to become.
 */
const exchangeBody = z.object({
  code: z
    .string({ required_error: 'A sign-in code is required' })
    .trim()
    .min(10, 'That sign-in code is not valid')
    .max(200, 'That sign-in code is not valid'),
});

module.exports = { exchangeBody };
