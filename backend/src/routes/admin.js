'use strict';

const express = require('express');
const { z } = require('zod');

const Course = require('../models/Course');
const Certificate = require('../models/Certificate');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');

const enrollmentService = require('../services/enrollmentService');
const notifications = require('../services/notificationService');
const certificateService = require('../services/certificateService');
const tokenService = require('../services/tokenService');
const email = require('../services/email');

const config = require('../config/env');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created } = require('../lib/respond');
const { notFound, badRequest, conflict } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const { contains } = require('../lib/text');
const { formatCents } = require('../lib/money');
const { ROLES, COURSE_STATUSES } = require('../lib/constants');

const { authenticate, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/auth');

const router = express.Router();

// Every route in this file is administrator-only. Applying it once here means a
// new endpoint cannot be added without it.
router.use(authenticate, requireAdmin);

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

const listQuery = z.object({
  status: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/* ------------------------------------------------------------------ *
 * GET /api/v1/admin/stats
 * ------------------------------------------------------------------ */

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [
      userCounts,
      courseCounts,
      enrollmentTotal,
      completedTotal,
      certificateTotal,
      pendingCourses,
      revenue,
      recentSignups,
      recentEnrollments,
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
      Course.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Enrollment.countDocuments({ status: { $ne: 'cancelled' } }),
      Enrollment.countDocuments({ status: 'completed' }),
      Certificate.countDocuments({ revokedAt: null }),
      Course.countDocuments({ status: 'pending' }),
      Payment.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: '$currency', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
      ]),
      User.find().sort({ createdAt: -1 }).limit(5).select('firstName lastName email role createdAt'),
      Enrollment.find({ status: { $ne: 'cancelled' } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate({ path: 'student', select: 'firstName lastName email' }),
    ]);

    const byRole = Object.fromEntries(userCounts.map((row) => [row._id, row.count]));
    const byStatus = Object.fromEntries(courseCounts.map((row) => [row._id, row.count]));

    const totalUsers = userCounts.reduce((sum, row) => sum + row.count, 0);
    const totalCourses = courseCounts.reduce((sum, row) => sum + row.count, 0);

    return ok(res, {
      users: {
        total: totalUsers,
        students: byRole.student || 0,
        instructors: byRole.instructor || 0,
        admins: byRole.admin || 0,
      },
      courses: {
        total: totalCourses,
        published: byStatus.published || 0,
        draft: byStatus.draft || 0,
        pending: byStatus.pending || 0,
        archived: byStatus.archived || 0,
      },
      enrollments: { total: enrollmentTotal, completed: completedTotal },
      certificates: { issued: certificateTotal },
      revenue: revenue
        .map((row) => ({
          currency: row._id,
          totalCents: row.total,
          totalLabel: formatCents(row.total, row._id),
          payments: row.count,
        }))
        .sort((a, b) => b.totalCents - a.totalCents),
      needsAttention: { pendingCourses },
      recent: {
        signups: recentSignups.map((user) => user.toPublicJSON({ includePrivate: true })),
        enrollments: recentEnrollments.map((enrollment) => ({
          id: String(enrollment._id),
          studentName: enrollment.student
            ? `${enrollment.student.firstName} ${enrollment.student.lastName}`
            : 'Unknown',
          studentEmail: enrollment.student?.email || null,
          courseTitle: enrollment.courseTitle,
          progress: enrollment.progress,
          enrolledAt: enrollment.createdAt,
        })),
      },
    });
  })
);

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

router.get(
  '/users',
  validate({ query: schemas.listUsersQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const filter = {};
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;

    if (query.q) {
      const pattern = contains(query.q);
      filter.$or = [{ firstName: pattern }, { lastName: pattern }, { email: pattern }];
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    const ids = users.map((user) => user._id);

    // Per-user enrolment counts in one aggregation rather than N queries.
    const counts = await Enrollment.aggregate([
      { $match: { student: { $in: ids }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$student', enrollments: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
    ]);

    const byId = new Map(counts.map((row) => [String(row._id), row]));

    return ok(
      res,
      paginated(
        users.map((user) =>
          user.toPublicJSON({
            includePrivate: true,
            stats: {
              enrollments: byId.get(String(user._id))?.enrollments || 0,
              completed: byId.get(String(user._id))?.completed || 0,
            },
          })
        ),
        total,
        { page, limit }
      )
    );
  })
);

/**
 * Create an account directly.
 *
 * Needed because public registration only ever produces students — there is no
 * self-service route to an instructor or administrator account, and this is the
 * only place a role may be set.
 */
router.post(
  '/users',
  writeLimiter,
  validate({
    body: z.object({
      firstName: schemas.name,
      lastName: schemas.name,
      email: schemas.email,
      password: schemas.password,
      role: z.enum(ROLES),
      headline: z.string().trim().max(120).optional(),
      bio: z.string().trim().max(600).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.valid.body;

    const existing = await User.findOne({ email: body.email }).select('_id');
    if (existing) {
      throw conflict('An account with that email already exists.', { code: 'EMAIL_IN_USE' });
    }

    const user = await User.create({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      password: body.password,
      role: body.role,
      headline: body.headline || null,
      bio: body.bio || null,
      // Created with a password chosen by an administrator, so the address is
      // treated as confirmed.
      emailVerified: true,
      emailVerifiedAt: new Date(),
    });

    return created(res, { user: user.toPublicJSON({ includePrivate: true }) }, 'Account created.');
  })
);

router.get(
  '/users/:id',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });

    const [enrollments, certificates, payments] = await Promise.all([
      Enrollment.find({ student: user._id, status: { $ne: 'cancelled' } })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate({ path: 'course', select: 'title slug thumbnail priceCents currency' }),
      Certificate.find({ student: user._id }).sort({ issueDate: -1 }).limit(20),
      Payment.find({ student: user._id }).sort({ createdAt: -1 }).limit(20),
    ]);

    return ok(res, {
      user: user.toPublicJSON({ includePrivate: true }),
      enrollments: enrollments.map((enrollment) => enrollment.toJSONForStudent()),
      certificates: certificates.map((certificate) => certificate.toJSONForOwner()),
      payments: payments.map((payment) => payment.toJSONForOwner()),
    });
  })
);

router.patch(
  '/users/:id',
  writeLimiter,
  validate({ params: z.object({ id: objectId }), body: schemas.updateUserBody }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });

    const body = req.valid.body;

    /**
     * Refuse to remove the last administrator. Without this an admin can
     * accidentally lock the whole platform out of its own admin area, and the
     * only fix is direct database access.
     */
    const isDemotingSelf = String(user._id) === String(req.user._id) && body.role && body.role !== 'admin';
    const isSuspendingSelf = String(user._id) === String(req.user._id) && body.status === 'suspended';

    if (isDemotingSelf || isSuspendingSelf) {
      throw badRequest('You cannot change your own role or suspend your own account.', {
        code: 'SELF_MODIFICATION_BLOCKED',
      });
    }

    if (user.role === 'admin' && (body.role && body.role !== 'admin' || body.status === 'suspended')) {
      const remainingAdmins = await User.countDocuments({
        role: 'admin',
        status: 'active',
        _id: { $ne: user._id },
      });

      if (remainingAdmins === 0) {
        throw conflict('This is the only active administrator account.', { code: 'LAST_ADMIN' });
      }
    }

    if (body.firstName !== undefined) user.firstName = body.firstName;
    if (body.lastName !== undefined) user.lastName = body.lastName;
    if (body.phone !== undefined) user.phone = body.phone || null;
    if (body.role !== undefined) user.role = body.role;
    if (body.status !== undefined) user.status = body.status;
    if (body.emailVerified !== undefined) {
      user.emailVerified = body.emailVerified;
      user.emailVerifiedAt = body.emailVerified ? new Date() : null;
    }

    await user.save();

    // Suspending an account must end its sessions immediately, not in 15 minutes.
    if (body.status === 'suspended') {
      await tokenService.revokeAllSessions(user._id);
    }

    return ok(res, { user: user.toPublicJSON({ includePrivate: true }) }, 'Account updated.');
  })
);

/* ------------------------------------------------------------------ *
 * Course moderation
 * ------------------------------------------------------------------ */

router.get(
  '/courses',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);
    const status = COURSE_STATUSES.includes(req.valid.query.status) ? req.valid.query.status : null;

    const filter = status ? { status } : {};

    const [courses, total] = await Promise.all([
      Course.find(filter)
        .sort({ status: 1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'instructor', select: 'firstName lastName email' }),
      Course.countDocuments(filter),
    ]);

    const enrollCounts = await Enrollment.aggregate([
      { $match: { course: { $in: courses.map((course) => course._id) }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]);

    const byId = new Map(enrollCounts.map((row) => [String(row._id), row.count]));

    return ok(
      res,
      paginated(
        courses.map((course) =>
          course.toCardJSON({
            instructor: course.instructor
              ? {
                  id: String(course.instructor._id),
                  name: `${course.instructor.firstName} ${course.instructor.lastName}`,
                  email: course.instructor.email,
                }
              : null,
            enrollmentCount: byId.get(String(course._id)) || 0,
            reviewNote: course.reviewNote,
          })
        ),
        total,
        { page, limit }
      )
    );
  })
);

router.post(
  '/courses/:id/approve',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.id);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    if (course.status === 'published') {
      return ok(res, { course: course.toCardJSON() }, 'This course is already published.');
    }

    course.status = 'published';
    course.publishedAt = course.publishedAt || new Date();
    course.reviewedBy = req.user._id;
    course.reviewedAt = new Date();
    course.reviewNote = null;
    await course.save();

    notifications
      .onCoursePublished(course.instructor, course, `/instructor-dashboard.html#/course/${course._id}`)
      .catch(() => {});

    return ok(res, { course: course.toCardJSON() }, 'Course approved and published.');
  })
);

router.post(
  '/courses/:id/reject',
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ note: z.string().trim().min(4, 'Explain what needs changing').max(500) }),
  }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.id);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    course.status = 'draft';
    course.reviewedBy = req.user._id;
    course.reviewedAt = new Date();
    course.reviewNote = req.valid.body.note;
    await course.save();

    notifications
      .notify(course.instructor, {
        title: 'Course needs changes',
        message: `"${course.title}" was returned to draft: ${req.valid.body.note}`,
        type: 'announcement',
        link: `/instructor-dashboard.html#/course/${course._id}`,
        meta: { courseId: String(course._id) },
      })
      .catch(() => {});

    return ok(res, { course: course.toCardJSON() }, 'Course returned to the instructor.');
  })
);

/* ------------------------------------------------------------------ *
 * Enrollments
 * ------------------------------------------------------------------ */

router.get(
  '/enrollments',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const [enrollments, total] = await Promise.all([
      Enrollment.find({ status: { $ne: 'cancelled' } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'student', select: 'firstName lastName email' })
        .populate({ path: 'course', select: 'title slug' }),
      Enrollment.countDocuments({ status: { $ne: 'cancelled' } }),
    ]);

    return ok(
      res,
      paginated(
        enrollments.map((enrollment) => ({
          id: String(enrollment._id),
          student: enrollment.student
            ? {
                id: String(enrollment.student._id),
                name: `${enrollment.student.firstName} ${enrollment.student.lastName}`,
                email: enrollment.student.email,
              }
            : null,
          course: enrollment.course
            ? { id: String(enrollment.course._id), title: enrollment.course.title, slug: enrollment.course.slug }
            : null,
          progress: enrollment.progress,
          status: enrollment.status,
          source: enrollment.source,
          enrolledAt: enrollment.createdAt,
          completedAt: enrollment.completedAt,
        })),
        total,
        { page, limit }
      )
    );
  })
);

/** Enrol a student by hand — for offline payments or support cases. */
router.post(
  '/enrollments',
  validate({ body: z.object({ studentId: objectId, courseId: objectId }) }),
  asyncHandler(async (req, res) => {
    const { studentId, courseId } = req.valid.body;

    const [student, course] = await Promise.all([User.findById(studentId), Course.findById(courseId)]);
    if (!student) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const { enrollment, created: isNew } = await enrollmentService.enroll({
      user: student,
      course,
      source: 'admin',
    });

    return isNew
      ? created(res, { enrollment: enrollment.toJSONForStudent() }, 'Student enrolled.')
      : ok(res, { enrollment: enrollment.toJSONForStudent() }, 'The student was already enrolled.');
  })
);

/* ------------------------------------------------------------------ *
 * Announcements
 * ------------------------------------------------------------------ */

router.post(
  '/announcements',
  writeLimiter,
  validate({
    body: z.object({
      title: z.string().trim().min(3, 'Give the announcement a title').max(160),
      message: z.string().trim().min(3, 'Write the announcement').max(1000),
      audience: z.enum(['all', 'students', 'instructors', 'course']).default('all'),
      courseId: objectId.optional(),
      sendEmail: z.coerce.boolean().optional().default(false),
      link: z.string().trim().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.valid.body;
    let recipients = [];

    if (body.audience === 'course') {
      if (!body.courseId) {
        throw badRequest('Choose a course for a course announcement.', {
          code: 'COURSE_REQUIRED',
          details: [{ field: 'courseId', message: 'A course is required' }],
        });
      }

      const course = await Course.findById(body.courseId);
      if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

      const enrollments = await Enrollment.find({
        course: course._id,
        status: { $ne: 'cancelled' },
      }).select('student');

      recipients = enrollments.map((enrollment) => enrollment.student);
    } else {
      const filter = body.audience === 'all' ? {} : { role: body.audience.slice(0, -1) };
      recipients = (await User.find({ ...filter, status: 'active' }).select('_id')).map((user) => user._id);
    }

    const issued = await notifications.notifyMany(recipients, {
      title: body.title,
      message: body.message,
      type: 'announcement',
      link: body.link || null,
    });

    if (body.sendEmail && recipients.length > 0) {
      // Bounded: an announcement to the whole platform should not open
      // thousands of simultaneous connections to the mail provider.
      setImmediate(async () => {
        const users = await User.find({ _id: { $in: recipients.slice(0, 500) } });

        for (const user of users) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await email.deliver(
              email.announcementEmail({
                user,
                title: body.title,
                message: body.message,
                url: body.link ? `${config.publicBaseUrl}${body.link}` : undefined,
              })
            );
          } catch (error) {
            logger.error('announcement email failed', { error, userId: String(user._id) });
          }
        }
      });
    }

    return created(
      res,
      { notified: issued.length, emailQueued: body.sendEmail ? Math.min(recipients.length, 500) : 0 },
      `Announcement sent to ${issued.length} ${issued.length === 1 ? 'person' : 'people'}.`
    );
  })
);

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

/**
 * List issued certificates.
 *
 * The admin area could revoke a certificate but could not show which ones
 * existed, so the dashboard had nothing to list and displayed invented rows
 * instead.
 */
router.get(
  '/certificates',
  validate({
    query: z.object({
      status: z.enum(['issued', 'revoked']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const filter = {};
    if (query.status === 'issued') filter.revokedAt = null;
    if (query.status === 'revoked') filter.revokedAt = { $ne: null };

    if (query.q) {
      const pattern = contains(query.q);
      filter.$or = [{ certificateNumber: pattern }, { studentName: pattern }, { courseTitle: pattern }];
    }

    const [certificates, total, issued, revoked] = await Promise.all([
      Certificate.find(filter).sort({ issueDate: -1 }).skip(skip).limit(limit),
      Certificate.countDocuments(filter),
      Certificate.countDocuments({ revokedAt: null }),
      Certificate.countDocuments({ revokedAt: { $ne: null } }),
    ]);

    return ok(res, {
      ...paginated(
        certificates.map((certificate) =>
          certificate.toJSONForOwner({
            studentId: String(certificate.student),
            courseId: String(certificate.course),
          })
        ),
        total,
        { page, limit }
      ),
      counts: { issued, revoked, total: issued + revoked },
    });
  })
);

router.post(
  '/certificates/:id/revoke',
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ reason: z.string().trim().max(500).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const certificate = await Certificate.findById(req.valid.params.id);
    if (!certificate) throw notFound('That certificate could not be found.', { code: 'CERTIFICATE_NOT_FOUND' });

    if (certificate.revokedAt) {
      return ok(res, { certificate: certificate.toJSONForOwner() }, 'This certificate is already revoked.');
    }

    const updated = await certificateService.revoke(certificate._id, req.valid.body.reason);

    return ok(res, { certificate: updated.toJSONForOwner() }, 'Certificate revoked.');
  })
);

module.exports = router;
