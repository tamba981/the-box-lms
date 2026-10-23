'use strict';

const { z } = require('zod');

const { objectId } = require('./auth');

const page = z.coerce.number().int().min(1).max(10000).optional();
const limit = z.coerce.number().int().min(1).max(100).optional();

const courseIdParam = z.object({
  // Either form the course detail route accepts: the id the pages use, or the
  // slug someone may paste in. Anything else is refused before it reaches a query.
  courseId: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,140}$/i, 'Invalid course identifier'),
});

const listReviewsQuery = z.object({
  page,
  limit,
  sort: z.enum(['newest', 'highest', 'lowest']).optional().default('newest'),
});

/**
 * A review a student submits.
 *
 * The body is required and has a minimum length because a one-word review is
 * indistinguishable from a rating, and the rating already exists as its own
 * field. The message is what a prospective student actually reads.
 */
const submitReviewBody = z.object({
  rating: z.coerce
    .number({ required_error: 'Choose a rating' })
    .int('A rating must be a whole number of stars')
    .min(1, 'Choose a rating between 1 and 5')
    .max(5, 'Choose a rating between 1 and 5'),
  title: z.string().trim().max(120, 'That title is too long').optional(),
  body: z
    .string({ required_error: 'Write your review' })
    .trim()
    .min(20, 'Write at least 20 characters so the review is useful')
    .max(4000, 'That review is too long'),
});

const reviewIdParam = z.object({ id: objectId });

const listModerationQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending'),
  courseId: objectId.optional(),
  page,
  limit,
});

const rejectReviewBody = z.object({
  reason: z
    .string({ required_error: 'Give a reason' })
    .trim()
    .min(10, 'Give a reason of at least 10 characters')
    .max(500, 'That reason is too long'),
});

module.exports = {
  courseIdParam,
  listReviewsQuery,
  submitReviewBody,
  reviewIdParam,
  listModerationQuery,
  rejectReviewBody,
};
