'use strict';

const express = require('express');

const Review = require('../models/Review');
const Enrollment = require('../models/Enrollment');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { notFound, forbidden } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const permissions = require('../lib/permissions');

const { authenticate, optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/reviews');

const { recomputeCourseRating, ratingSummary } = require('../services/reviewService');

/**
 * Course reviews.
 *
 * Mounted under the course, so `:courseId` identifies the subject and all the
 * access rules are the course's own: anyone may read approved reviews of a
 * published course, and only an enrolled student may write one.
 */
const router = express.Router({ mergeParams: true });

const SORTS = {
  newest: { createdAt: -1 },
  highest: { rating: -1, createdAt: -1 },
  lowest: { rating: 1, createdAt: -1 },
};

/**
 * A review is written by someone who is actually taking the course.
 *
 * A cancelled enrolment does not count: the student is no longer taking it, and
 * a review written after leaving is the one most likely to be about the exit
 * rather than the teaching.
 */
async function assertEnrolled(user, courseId) {
  const enrollment = await Enrollment.findOne({ student: user._id, course: courseId });

  if (!enrollment || enrollment.status === 'cancelled') {
    throw forbidden('Enrol in this course before reviewing it.', { code: 'ENROLLMENT_REQUIRED' });
  }

  return enrollment;
}

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses/:courseId/reviews — approved reviews, public
 * ------------------------------------------------------------------ */

router.get(
  '/',
  optionalAuth,
  validate({ params: schemas.courseIdParam, query: schemas.listReviewsQuery }),
  asyncHandler(async (req, res) => {
    const course = await permissions.loadVisibleCourse(req.valid.params.courseId, req.user);
    const { page, limit, skip } = parsePagination(req.valid.query);

    const filter = { course: course._id, status: 'approved' };

    const [reviews, total, summary, mine] = await Promise.all([
      Review.find(filter).sort(SORTS[req.valid.query.sort]).skip(skip).limit(limit),
      Review.countDocuments(filter),
      ratingSummary(course._id),
      req.user ? Review.findOne({ course: course._id, student: req.user._id }) : null,
    ]);

    return ok(res, {
      ...paginated(
        reviews.map((review) => review.toJSONForViewer(req.user && req.user._id)),
        total,
        { page, limit }
      ),
      summary,
      // The author sees their own review whatever its state, so an edit screen
      // can start from what they wrote rather than from a blank form.
      myReview: mine ? mine.toJSONForViewer(req.user._id) : null,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/courses/:courseId/reviews — write or replace your review
 * ------------------------------------------------------------------ */

router.post(
  '/',
  authenticate,
  writeLimiter,
  validate({ params: schemas.courseIdParam, body: schemas.submitReviewBody }),
  asyncHandler(async (req, res) => {
    const course = await permissions.loadVisibleCourse(req.valid.params.courseId, req.user);
    await assertEnrolled(req.user, course._id);

    const { rating, title = '', body } = req.valid.body;

    let review = await Review.findOne({ course: course._id, student: req.user._id });
    const isNew = !review;

    if (!review) review = new Review({ course: course._id, student: req.user._id });

    review.rating = rating;
    review.title = title;
    review.body = body;
    review.studentName = req.user.fullName;
    review.studentAvatar = req.user.avatarUrl || null;

    /**
     * Every edit goes back through moderation, and any earlier decision is
     * cleared. An approved review that is then rewritten would otherwise keep its
     * approval for text nobody has read.
     */
    review.status = 'pending';
    review.moderatedBy = null;
    review.moderatedAt = null;
    review.moderationNote = null;

    await review.save();

    /**
     * An approved review that has just been rewritten is no longer approved, so
     * the course must stop counting it. Recomputing unconditionally also covers
     * the first submission, where there is nothing to remove.
     */
    await recomputeCourseRating(course._id);

    const payload = { review: review.toJSONForViewer(req.user._id) };
    const message = isNew
      ? 'Thank you. Your review will appear once it has been checked.'
      : 'Your review was updated and will be checked again before it appears.';

    return isNew ? created(res, payload, message) : ok(res, payload, message);
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/courses/:courseId/reviews/mine — withdraw your review
 * ------------------------------------------------------------------ */

router.delete(
  '/mine',
  authenticate,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await permissions.loadVisibleCourse(req.valid.params.courseId, req.user);

    const deleted = await Review.findOneAndDelete({ course: course._id, student: req.user._id });
    if (!deleted) throw notFound('You have not reviewed this course.', { code: 'REVIEW_NOT_FOUND' });

    // Only an approved review was counted, but a pending one never was, so the
    // recompute is cheap and cannot be wrong either way.
    await recomputeCourseRating(course._id);

    return noContent(res);
  })
);

module.exports = router;
