'use strict';

const { z } = require('zod');

const { email } = require('./auth');

/**
 * What the business, university and government pages may send.
 *
 * One schema for all three: the pages ask different questions but they are the
 * same kind of lead, and one queue is easier to work than three. `audience` is
 * how the reader knows which page it came from.
 *
 * `interests` is capped so a scripted request cannot post a megabyte of strings,
 * and each one is length-checked for the same reason.
 */
const INTEREST_MAX = 12;

const enquiryBody = z.object({
  audience: z.enum(['business', 'university', 'government']).default('business'),
  company: z.string().trim().min(2, 'Tell us the name of your organisation').max(160),
  contactName: z.string().trim().min(2, 'Tell us your name').max(120),
  email,
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => (value ? value : null)),
  teamSize: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => (value ? value : null)),
  timeline: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => (value ? value : null)),
  interests: z
    .array(z.string().trim().min(2).max(60))
    .max(INTEREST_MAX)
    .optional()
    .default([]),
  message: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => (value ? value : null)),
});

module.exports = { enquiryBody, INTEREST_MAX };
