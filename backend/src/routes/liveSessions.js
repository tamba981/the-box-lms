'use strict';

const express = require('express');

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const LiveSession = require('../models/LiveSession');

const notifications = require('../services/notificationService');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const permissions = require('../lib/permissions');

const { authenticate, requireInstructor } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/social');

const router = express.Router();

/**
 * Live sessions.
 *
 * The join link is the sensitive field: it is the one thing that turns a listed
 * date into a seat in the room. It is therefore excluded from every list
 * response and only attached when the caller is enrolled, teaches the course,
 * or is an admin.
 */

async function assertHost(user, course) {
  const manages = permissions.canManageCourse(user, course);
  if (!manages) {
    throw forbidden('You can only schedule sessions for courses you teach.', { code: 'NOT_COURSE_OWNER' });
  }
}

/* ------------------------------------------------------------------ *
 * GET /api/v1/live-sessions
 * ------------------------------------------------------------------ */

router.get(
  '/',
  authenticate,
  validate({ query: schemas.listSessionsQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const filter = {};
    const now = new Date();

    if (query.scope === 'upcoming') filter.endTime = { $gte: now };
    else if (query.scope === 'past') filter.endTime = { $lt: now };

    if (query.courseId) {
      const course = await Course.findById(query.courseId);
      if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

      const access = await permissions.resolveCourseAccess(req.user, course);
      if (!access.canReadContent) {
        throw forbidden('Enroll in this course to see its live sessions.', { code: 'ENROLLMENT_REQUIRED' });
      }

      filter.course = query.courseId;
    } else if (req.user.role === 'student') {
      // A student's feed is their own courses only.
      const enrollments = await Enrollment.find({ student: req.user._id, status: { $ne: 'cancelled' } }).select('course');
      filter.course = { $in: enrollments.map((enrollment) => enrollment.course) };
    } else if (req.user.role === 'instructor') {
      filter.instructor = req.user._id;
    }

    const [sessions, total] = await Promise.all([
      LiveSession.find(filter).sort({ startTime: query.scope === 'past' ? -1 : 1 }).skip(skip).limit(limit),
      LiveSession.countDocuments(filter),
    ]);

    // Which of these is the viewer actually enrolled in — decides the join link.
    const accessibleCourseIds = new Set();

    if (req.user.role === 'admin') {
      for (const session of sessions) accessibleCourseIds.add(String(session.course));
    } else {
      const enrollments = await Enrollment.find({
        student: req.user._id,
        course: { $in: sessions.map((session) => session.course) },
        status: { $ne: 'cancelled' },
      }).select('course');

      for (const enrollment of enrollments) accessibleCourseIds.add(String(enrollment.course));

      const teaching = await Course.find({ instructor: req.user._id, _id: { $in: sessions.map((s) => s.course) } }).select('_id');
      for (const course of teaching) accessibleCourseIds.add(String(course._id));
    }

    return ok(
      res,
      paginated(
        sessions.map((session) =>
          session.toJSONFor(req.user._id, { canJoin: accessibleCourseIds.has(String(session.course)) })
        ),
        total,
        { page, limit }
      )
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/live-sessions/upcoming — dashboard widget
 * ------------------------------------------------------------------ */

router.get(
  '/upcoming',
  authenticate,
  asyncHandler(async (req, res) => {
    const enrollments = await Enrollment.find({
      student: req.user._id,
      status: { $ne: 'cancelled' },
    }).select('course');

    const courseIds = enrollments.map((enrollment) => enrollment.course);

    const sessions = await LiveSession.find({
      course: { $in: courseIds },
      endTime: { $gte: new Date() },
      status: { $ne: 'cancelled' },
    })
      .sort({ startTime: 1 })
      .limit(5);

    return ok(res, {
      sessions: sessions.map((session) => session.toJSONFor(req.user._id, { canJoin: true })),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/live-sessions — schedule
 * ------------------------------------------------------------------ */

router.post(
  '/',
  authenticate,
  requireInstructor,
  writeLimiter,
  validate({ body: schemas.createSessionBody }),
  asyncHandler(async (req, res) => {
    const body = req.valid.body;

    const course = await Course.findById(body.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
    await assertHost(req.user, course);

    const session = await LiveSession.create({
      course: course._id,
      courseTitle: course.title,
      title: body.title,
      description: body.description || '',
      instructor: req.user._id,
      instructorName: req.user.fullName,
      startTime: body.startTime,
      endTime: body.endTime,
      meetingLink: body.meetingLink || null,
      status: 'scheduled',
    });

    // Tell everyone who can attend. Only the announcement is sent here — not
    // the join link, which stays behind the access check.
    const enrollments = await Enrollment.find({ course: course._id, status: { $ne: 'cancelled' } }).select('student');

    notifications
      .onLiveSession(
        enrollments.map((enrollment) => enrollment.student),
        { ...session.toObject(), courseTitle: course.title },
        `/student-dashboard.html#/live`
      )
      .catch(() => {});

    return created(res, { session: session.toJSONFor(req.user._id, { canJoin: true }) }, 'Session scheduled.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/live-sessions/:id
 * ------------------------------------------------------------------ */

router.get(
  '/:id',
  authenticate,
  validate({ params: schemas.sessionIdParam }),
  asyncHandler(async (req, res) => {
    // `meetingLink` is `select: false`, so it must be asked for explicitly.
    const session = await LiveSession.findById(req.valid.params.id).select('+meetingLink');
    if (!session) throw notFound('That session could not be found.', { code: 'SESSION_NOT_FOUND' });

    const course = await Course.findById(session.course);
    const access = course ? await permissions.resolveCourseAccess(req.user, course) : { canReadContent: false };

    const canJoin = access.canReadContent || req.user.role === 'admin';

    if (!canJoin) {
      throw forbidden('Enroll in this course to join this session.', { code: 'ENROLLMENT_REQUIRED' });
    }

    return ok(res, { session: session.toJSONFor(req.user._id, { canJoin: true }) });
  })
);

/* ------------------------------------------------------------------ *
 * PATCH /api/v1/live-sessions/:id
 * ------------------------------------------------------------------ */

router.patch(
  '/:id',
  authenticate,
  requireInstructor,
  validate({ params: schemas.sessionIdParam, body: schemas.updateSessionBody }),
  asyncHandler(async (req, res) => {
    const session = await LiveSession.findById(req.valid.params.id).select('+meetingLink');
    if (!session) throw notFound('That session could not be found.', { code: 'SESSION_NOT_FOUND' });

    const course = await Course.findById(session.course);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
    await assertHost(req.user, course);

    const body = req.valid.body;

    // Validate the resulting window, not just the fields that were sent.
    const startTime = body.startTime || session.startTime;
    const endTime = body.endTime || session.endTime;

    if (endTime.getTime() <= startTime.getTime()) {
      throw badRequest('The end time must be after the start time.', {
        code: 'INVALID_WINDOW',
        details: [{ field: 'endTime', message: 'Must be after the start time' }],
      });
    }

    if (body.title !== undefined) session.title = body.title;
    if (body.description !== undefined) session.description = body.description;
    if (body.startTime !== undefined) session.startTime = body.startTime;
    if (body.endTime !== undefined) session.endTime = body.endTime;
    if (body.meetingLink !== undefined) session.meetingLink = body.meetingLink || null;
    if (body.recordingUrl !== undefined) session.recordingUrl = body.recordingUrl || null;
    if (body.status !== undefined) session.status = body.status;

    await session.save();

    return ok(res, { session: session.toJSONFor(req.user._id, { canJoin: true }) }, 'Session updated.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/live-sessions/:id/attend — RSVP
 * ------------------------------------------------------------------ */

router.post(
  '/:id/attend',
  authenticate,
  validate({ params: schemas.sessionIdParam }),
  asyncHandler(async (req, res) => {
    const session = await LiveSession.findById(req.valid.params.id);
    if (!session) throw notFound('That session could not be found.', { code: 'SESSION_NOT_FOUND' });

    const course = await Course.findById(session.course);
    const access = course ? await permissions.resolveCourseAccess(req.user, course) : { canReadContent: false };

    if (!access.canReadContent && req.user.role !== 'admin') {
      throw forbidden('Enroll in this course to attend this session.', { code: 'ENROLLMENT_REQUIRED' });
    }

    // Toggle: `$addToSet` and `$pull` cannot both double-count.
    const attending = session.attendees.some((id) => String(id) === String(req.user._id));

    await LiveSession.updateOne(
      { _id: session._id },
      attending ? { $pull: { attendees: req.user._id } } : { $addToSet: { attendees: req.user._id } }
    );

    const updated = await LiveSession.findById(session._id);

    return ok(
      res,
      { attending: !attending, attendeeCount: updated.attendees.length },
      attending ? 'Removed from the guest list.' : 'You are on the guest list.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/live-sessions/:id
 * ------------------------------------------------------------------ */

router.delete(
  '/:id',
  authenticate,
  requireInstructor,
  validate({ params: schemas.sessionIdParam }),
  asyncHandler(async (req, res) => {
    const session = await LiveSession.findById(req.valid.params.id);
    if (!session) throw notFound('That session could not be found.', { code: 'SESSION_NOT_FOUND' });

    const course = await Course.findById(session.course);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
    await assertHost(req.user, course);

    // Cancelled rather than deleted: attendees keep the record of what they had
    // signed up for.
    session.status = 'cancelled';
    await session.save();

    return noContent(res, 'Session cancelled.');
  })
);

module.exports = router;
