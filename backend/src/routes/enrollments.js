'use strict';

const express = require('express');

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Lesson = require('../models/Lesson');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, noContent } = require('../lib/respond');
const { notFound } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const permissions = require('../lib/permissions');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { courseIdParam } = require('../validators/courses');
const { z } = require('zod');

const router = express.Router();

const listMineQuery = z.object({
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/* ------------------------------------------------------------------ *
 * GET /api/v1/enrollments/me — my courses
 * ------------------------------------------------------------------ */

router.get(
  '/me',
  authenticate,
  validate({ query: listMineQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);
    const status = req.valid.query.status || null;

    const filter = { student: req.user._id };
    if (status) filter.status = status;
    else filter.status = { $ne: 'cancelled' };

    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter)
        .sort({ lastAccessedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        // The instructor is populated so the student can message them without a
        // second round trip per course.
        .populate({ path: 'course', populate: { path: 'instructor', select: 'firstName lastName avatarUrl' } }),
      Enrollment.countDocuments(filter),
    ]);

    // A course can have been archived or deleted since enrolment; keep the
    // record but never send a card without a course.
    const items = enrollments
      .filter((enrollment) => enrollment.course)
      .map((enrollment) => enrollment.toJSONForStudent());

    return ok(res, paginated(items, total, { page, limit }));
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/enrollments/me/:courseId — one course, with its lessons
 * ------------------------------------------------------------------ */

router.get(
  '/me/:courseId',
  authenticate,
  validate({ params: courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const enrollment = await permissions.findEnrollment(req.user._id, course._id);
    if (!enrollment && req.user.role !== 'admin') {
      throw notFound('You are not enrolled in this course.', { code: 'NOT_ENROLLED' });
    }

    const lessons = await Lesson.find({ course: course._id, published: true }).sort({ order: 1 });
    const completed = new Set((enrollment?.completedLessons || []).map(String));

    return ok(res, {
      course: course.toCardJSON(),
      enrollment: enrollment ? enrollment.toJSONForStudent() : null,
      lessons: lessons.map((lesson) =>
        lesson.toSummaryJSON({
          completed: completed.has(String(lesson._id)),
          locked: !enrollment,
        })
      ),
    });
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/enrollments/me/:courseId — leave a course
 * ------------------------------------------------------------------ */

router.delete(
  '/me/:courseId',
  authenticate,
  validate({ params: courseIdParam }),
  asyncHandler(async (req, res) => {
    const enrollment = await permissions.findEnrollment(req.user._id, req.valid.params.courseId);

    if (!enrollment) throw notFound('You are not enrolled in this course.', { code: 'NOT_ENROLLED' });

    // The record stays so a certificate and payment history survive; the status
    // is what removes it from the student's list and closes access.
    enrollment.status = 'cancelled';
    await enrollment.save();

    await Course.updateOne({ _id: enrollment.course }, { $inc: { enrolledCount: -1 } });

    return noContent(res, 'You have left this course.');
  })
);

module.exports = router;
