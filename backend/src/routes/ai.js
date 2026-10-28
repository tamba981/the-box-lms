'use strict';

/**
 * AI routes.
 *
 * Mounted under `/api/v1/ai`. Every route authenticates: there is no anonymous
 * AI surface, because every call costs money and every answer is personal.
 *
 * The two instructor routes live here too rather than under `/instructor`,
 * because they share the credit ledger, the model and the auditing with the
 * student ones — and because "who may call this" is a property of each route,
 * not of the URL.
 */

const express = require('express');

const config = require('../config/env');
const aiService = require('../services/aiService');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Lesson = require('../models/Lesson');
const permissions = require('../lib/permissions');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { forbidden, notFound } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate, requireInstructor } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/ai');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * GET /api/v1/ai/credits
 * ------------------------------------------------------------------ */

router.get(
  '/credits',
  authenticate,
  asyncHandler(async (req, res) => {
    const credits = await aiService.creditStatus(req.user._id);

    return ok(res, {
      enabled: config.ai.enabled,
      model: config.ai.model,
      credits,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/ai/tutor
 * ------------------------------------------------------------------ */

router.post(
  '/tutor',
  authenticate,
  aiLimiter,
  validate({ body: schemas.tutorBody }),
  asyncHandler(async (req, res) => {
    aiService.assertEnabled();

    const { lessonId, question } = req.valid.body;

    const lesson = await Lesson.findById(lessonId).select('title content course isPreview');
    if (!lesson) throw notFound('That lesson could not be found.', { code: 'LESSON_NOT_FOUND' });

    const course = await Course.findById(lesson.course).select('title instructor priceCents status');
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    /**
     * The tutor reads the lesson, so it is gated exactly like the lesson itself:
     * enrolment, ownership, or a published preview. Otherwise it would be a way
     * to read course content without paying for it, one question at a time.
     */
    const access = await permissions.resolveCourseAccess(req.user, course);
    if (!access.canReadContent && !lesson.isPreview) {
      throw forbidden('Enrol in this course to use the tutor on this lesson.', {
        code: 'ENROLLMENT_REQUIRED',
      });
    }

    const result = await aiService.tutor({ user: req.user, lesson, course, question });

    return ok(res, {
      answer: result.answer,
      credits: await aiService.creditStatus(req.user._id),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/ai/mentor
 * ------------------------------------------------------------------ */

router.post(
  '/mentor',
  authenticate,
  aiLimiter,
  validate({ body: schemas.mentorBody }),
  asyncHandler(async (req, res) => {
    aiService.assertEnabled();

    // Context is built here, not accepted from the client: progress is a fact
    // the server knows, and a browser could claim any of it.
    const enrollments = await Enrollment.find({
      student: req.user._id,
      status: { $in: ['active', 'completed'] },
    })
      .sort({ lastAccessedAt: -1 })
      .limit(5)
      .select('courseTitle progress status')
      .lean();

    const context = [
      `Student: ${req.user.firstName} ${req.user.lastName}`.trim(),
      req.user.location ? `Location: ${req.user.location}` : null,
      enrollments.length
        ? 'Courses they are taking:\n' +
          enrollments
            .map((row) => `- ${row.courseTitle || 'A course'} (${row.progress || 0}%, ${row.status})`)
            .join('\n')
        : 'They are not enrolled in a course yet.',
      'Wuteve Global Academy is in Monrovia, Liberia, and teaches practical, career-focused courses.',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await aiService.mentor({
      user: req.user,
      history: req.valid.body.messages,
      context,
    });

    return ok(res, {
      answer: result.answer,
      credits: await aiService.creditStatus(req.user._id),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/ai/career-assessment
 * ------------------------------------------------------------------ */

router.post(
  '/career-assessment',
  authenticate,
  aiLimiter,
  validate({ body: schemas.assessmentBody }),
  asyncHandler(async (req, res) => {
    aiService.assertEnabled();

    const result = await aiService.careerAssessment({ user: req.user, answers: req.valid.body });

    return ok(res, {
      summary: result.summary,
      paths: result.paths,
      credits: await aiService.creditStatus(req.user._id),
    });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/ai/insights?courseId=
 * ------------------------------------------------------------------ */

router.get(
  '/insights',
  authenticate,
  requireInstructor,
  validate({ query: schemas.insightsQuery }),
  asyncHandler(async (req, res) => {
    aiService.assertEnabled();

    const course = await Course.findById(req.valid.query.courseId).select('title instructor');
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    permissions.assertCanManageCourse(req.user, course);

    const result = await aiService.instructorInsights({ course });

    return ok(res, { course: { id: String(course._id), title: course.title }, ...result });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/ai/feedback-draft
 * ------------------------------------------------------------------ */

router.post(
  '/feedback-draft',
  authenticate,
  requireInstructor,
  aiLimiter,
  validate({ body: schemas.feedbackBody }),
  asyncHandler(async (req, res) => {
    aiService.assertEnabled();

    const course = await Course.findById(req.valid.body.courseId).select('title instructor');
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    permissions.assertCanManageCourse(req.user, course);

    const result = await aiService.draftFeedback({
      course,
      submission: req.valid.body.submission,
      rubric: req.valid.body.rubric,
    });

    logger.info('ai feedback draft generated', {
      course: String(course._id),
      by: String(req.user._id),
    });

    return ok(res, { draft: result.draft });
  })
);

module.exports = router;
