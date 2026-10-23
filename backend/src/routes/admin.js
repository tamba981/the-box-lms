'use strict';

const express = require('express');
const { z } = require('zod');

const Course = require('../models/Course');
const Certificate = require('../models/Certificate');
const ContactMessage = require('../models/ContactMessage');
const Enrollment = require('../models/Enrollment');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const User = require('../models/User');

const enrollmentService = require('../services/enrollmentService');
const notifications = require('../services/notificationService');
const certificateService = require('../services/certificateService');
const tokenService = require('../services/tokenService');
const paymentService = require('../services/paymentService');
const email = require('../services/email');

const config = require('../config/env');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created } = require('../lib/respond');
const { notFound, badRequest, conflict } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const { contains } = require('../lib/text');
const { formatCents } = require('../lib/money');
const { sendCv } = require('../lib/cvDownload');
const { ROLES, COURSE_STATUSES } = require('../lib/constants');
const { generatePassword } = require('../lib/generatePassword');

const { authenticate, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/auth');
const reviewSchemas = require('../validators/reviews');
const { recomputeCourseRating } = require('../services/reviewService');

const router = express.Router();

// Every route in this file is administrator-only. Applying it once here means a
// new endpoint cannot be added without it.
router.use(authenticate, requireAdmin);

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

/** A manual order's reference, matched case-insensitively. */
const orderRef = z
  .string()
  .trim()
  .regex(/^WGA-\d{10,16}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/i, 'That is not an order reference');

/** Escape a user's search text so it cannot act as a regular expression. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const listQuery = z.object({
  status: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/* ------------------------------------------------------------------ *
 * GET /api/v1/admin/system — what this deployment is actually configured to do
 * ------------------------------------------------------------------ */

/**
 * Integration status, for an administrator.
 *
 * The deployment has several features that are present in the code and inert
 * until they are configured: email until a provider key exists, uploads until
 * storage exists, card and mobile-money payments until their credentials are
 * set. Each degrades quietly by design — a student finishing a course must not
 * get a 500 because the mail provider is down.
 *
 * The cost of degrading quietly is that a broken integration looks exactly like
 * a working one. This endpoint answers "is it on?" from outside the server, so
 * nobody has to read Railway's variables or a log file to find out.
 *
 * It deliberately reports only booleans and addresses the operator already
 * knows. No API key, secret or connection string is included, and none can be
 * added here by accident: every field below is computed, not copied.
 */
router.get(
  '/system',
  asyncHandler(async (req, res) => {
    const mobileMoney = {};

    for (const provider of config.mobileMoney || []) {
      mobileMoney[provider.id] = Boolean(provider.configured);
    }

    return ok(res, {
      email: {
        enabled: config.email.enabled,
        // The address mail is sent from. Not a secret, and the single most
        // common cause of "it says sent but nothing arrived": a From on a
        // domain the provider has not verified.
        from: config.email.from,
        inbox: config.email.inbox,
      },
      publicBaseUrl: config.publicBaseUrl,
      storage: { enabled: config.storage.enabled },
      payments: {
        manual: (config.manualPayment.numbers || []).length > 0,
        card: config.stripe.enabled,
        orangeMoney: Boolean(mobileMoney.orange_money),
        lonestar: Boolean(mobileMoney.lonestar_momo),
      },
      nodeEnv: config.env,
    });
  })
);

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
      // Issued, not merely recorded: a certificate waiting to be paid for is not
      // a certificate the academy has awarded, and the summary card says so.
      Certificate.countDocuments({ revokedAt: null, status: { $ne: 'pending_payment' } }),
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

    // An instructor created here has no other way of learning the account exists:
    // their administrator chose the password and has to pass it on out of band.
    if (user.role === 'instructor') {
      setImmediate(async () => {
        try {
          await email.deliver(email.instructorAccountEmail({ user }));
        } catch (error) {
          logger.error('instructor account email failed', { error, userId: String(user._id) });
        }
      });
    }

    return created(res, { user: user.toPublicJSON({ includePrivate: true }) }, 'Account created.');
  })
);

/* ------------------------------------------------------------------ *
 * Instructor CVs
 *
 * An instructor uploads a CV from their own profile; an administrator reads it
 * here and either approves it or sends it back with a reason. The file itself is
 * never part of any JSON payload — only the review state is.
 * ------------------------------------------------------------------ */

const CV_STATUSES = ['pending', 'approved', 'rejected'];

router.get(
  '/instructors/cv',
  validate({ query: z.object({ status: z.enum(CV_STATUSES).optional() }) }),
  asyncHandler(async (req, res) => {
    // Pending is the queue an administrator is actually working through, so it
    // is the default rather than "everything".
    const status = req.valid.query.status || 'pending';

    const instructors = await User.find({ role: 'instructor', cvStatus: status })
      .sort({ cvUploadedAt: 1 })
      .limit(200)
      .select('firstName lastName email cvStatus cvUploadedAt cvOriginalFilename');

    return ok(res, {
      status,
      instructors: instructors.map((instructor) => ({
        id: String(instructor._id),
        name: `${instructor.firstName} ${instructor.lastName}`.trim(),
        email: instructor.email,
        cvStatus: instructor.cvStatus,
        cvUploadedAt: instructor.cvUploadedAt,
        cvOriginalFilename: instructor.cvOriginalFilename,
      })),
    });
  })
);

router.get(
  '/instructors/:id/cv',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    // `+cvImage` because the field is excluded from every query by default.
    const instructor = await User.findById(req.valid.params.id).select('+cvImage');

    // One answer for "no such person", "not an instructor" and "never uploaded":
    // an administrator does not need to be told which.
    if (!instructor || !instructor.cvImage || instructor.cvImage.length === 0) {
      throw notFound('That CV could not be found.', { code: 'CV_NOT_FOUND' });
    }

    sendCv(res, instructor);
  })
);

router.post(
  '/instructors/:id/cv/approve',
  writeLimiter,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const instructor = await User.findById(req.valid.params.id);

    // `cvStatus` is set when a CV is uploaded and cleared nowhere else, so its
    // presence answers "is there something to review" without loading the file.
    if (!instructor || !instructor.cvStatus) {
      throw notFound('That CV could not be found.', { code: 'CV_NOT_FOUND' });
    }

    instructor.cvStatus = 'approved';
    instructor.cvReviewedBy = req.user._id;
    instructor.cvReviewedAt = new Date();
    // Approving supersedes an earlier refusal; leaving the old reason attached
    // would show the instructor a rejection note on an approved CV.
    instructor.cvRejectionReason = null;

    await instructor.save();

    setImmediate(async () => {
      try {
        await email.deliver(email.cvApprovedEmail({ user: instructor }));
      } catch (error) {
        logger.error('CV approved email failed', { error, instructorId: String(instructor._id) });
      }
    });

    return ok(
      res,
      { instructor: instructor.toPublicJSON({ includePrivate: true }) },
      'CV approved.'
    );
  })
);

router.post(
  '/instructors/:id/cv/reject',
  writeLimiter,
  validate({
    params: z.object({ id: objectId }),
    body: z.object({
      reason: z
        .string({ required_error: 'Give the instructor a reason' })
        .trim()
        .min(10, 'Give a reason of at least 10 characters')
        .max(500, 'That reason is too long'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const instructor = await User.findById(req.valid.params.id);

    if (!instructor || !instructor.cvStatus) {
      throw notFound('That CV could not be found.', { code: 'CV_NOT_FOUND' });
    }

    instructor.cvStatus = 'rejected';
    instructor.cvRejectionReason = req.valid.body.reason;
    instructor.cvReviewedBy = req.user._id;
    instructor.cvReviewedAt = new Date();

    await instructor.save();

    setImmediate(async () => {
      try {
        await email.deliver(
          email.cvRejectedEmail({ user: instructor, reason: req.valid.body.reason })
        );
      } catch (error) {
        logger.error('CV rejected email failed', { error, instructorId: String(instructor._id) });
      }
    });

    return ok(
      res,
      { instructor: instructor.toPublicJSON({ includePrivate: true }) },
      'CV sent back to the instructor.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * Instructor applications
 *
 * A self-registered instructor is created `pending` and cannot sign in until
 * one of these decides it. Approval and rejection are separate endpoints rather
 * than one `PATCH status`, because each has to send a different email and a
 * rejection has to carry a reason.
 * ------------------------------------------------------------------ */

router.post(
  '/instructors/:id/approve',
  writeLimiter,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const instructor = await User.findById(req.valid.params.id);
    if (!instructor) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });

    if (instructor.role !== 'instructor') {
      throw badRequest('That account is not an instructor.', { code: 'NOT_AN_INSTRUCTOR' });
    }

    if (instructor.status === 'active') {
      return ok(res, { instructor: instructor.toPublicJSON({ includePrivate: true }) }, 'That instructor is already active.');
    }

    instructor.status = 'active';
    instructor.statusReason = null;
    instructor.reviewedBy = req.user._id;
    instructor.reviewedAt = new Date();
    await instructor.save();

    setImmediate(async () => {
      try {
        await email.deliver(email.instructorApprovedEmail({ user: instructor }));
      } catch (error) {
        logger.error('Instructor approved email failed', { error, instructorId: String(instructor._id) });
      }
    });

    return ok(
      res,
      { instructor: instructor.toPublicJSON({ includePrivate: true }) },
      'Instructor approved. They can sign in now.'
    );
  })
);

router.post(
  '/instructors/:id/reject',
  writeLimiter,
  validate({
    params: z.object({ id: objectId }),
    body: z.object({
      reason: z
        .string({ required_error: 'Give the applicant a reason' })
        .trim()
        .min(10, 'Give a reason of at least 10 characters')
        .max(500, 'That reason is too long'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const instructor = await User.findById(req.valid.params.id);
    if (!instructor) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });

    if (instructor.role !== 'instructor') {
      throw badRequest('That account is not an instructor.', { code: 'NOT_AN_INSTRUCTOR' });
    }

    instructor.status = 'rejected';
    instructor.statusReason = req.valid.body.reason;
    instructor.reviewedBy = req.user._id;
    instructor.reviewedAt = new Date();
    await instructor.save();

    setImmediate(async () => {
      try {
        await email.deliver(
          email.instructorRejectedEmail({ user: instructor, reason: req.valid.body.reason })
        );
      } catch (error) {
        logger.error('Instructor rejected email failed', { error, instructorId: String(instructor._id) });
      }
    });

    return ok(
      res,
      { instructor: instructor.toPublicJSON({ includePrivate: true }) },
      'Application rejected and the applicant has been told why.'
    );
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

/**
 * Issue a replacement password for an account, and show it once.
 *
 * Password recovery normally goes by email, which only works where a mail provider
 * is configured. Without one, a user who has forgotten their password has no way
 * back in — and until this route neither did an administrator, because
 * `PATCH /users/:id` deliberately cannot touch a password field. The only remedy
 * left was editing the database by hand, which is worse in every way: no audit
 * trail, no session invalidation, and a plaintext password in a shell history.
 *
 * The password is generated here rather than chosen by the administrator, so it is
 * not something a person picked and can be guessed from who they are. It is
 * returned in this response and nowhere else — never logged, never stored in the
 * clear. `passwordChangedAt` is set and every session revoked, exactly as
 * `POST /auth/change-password` does, so whoever held the old password loses access
 * the moment this runs. The account holder is told by email where that is
 * configured.
 */
router.post(
  '/users/:id/reset-password',
  writeLimiter,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('That account could not be found.', { code: 'USER_NOT_FOUND' });

    const password = generatePassword();

    // Assigned as plain text; the model hashes it in its pre-save hook.
    user.password = password;
    // Invalidates every access token minted before this moment.
    user.passwordChangedAt = new Date();
    await user.save();

    // Whoever held the old password is signed out everywhere, immediately.
    await tokenService.revokeAllSessions(user._id);

    try {
      await email.deliver(email.passwordChangedEmail({ user }));
    } catch (error) {
      // The password is already set and is on its way to the administrator; a
      // provider failure must not turn this into a failed request.
      logger.error('password-change notice failed', { error, userId: String(user._id) });
    }

    // Recorded without the password. An administrator silently taking over an
    // account should be visible afterwards, to somebody other than that
    // administrator.
    logger.info('administrator issued a replacement password', {
      targetUserId: String(user._id),
      actorUserId: String(req.user._id),
    });

    return ok(
      res,
      { password },
      'A replacement password was issued. Give it to them now — it is shown once and stored nowhere.'
    );
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
 * Manual payments — the offline queue a person works through
 * ------------------------------------------------------------------ */

const MANUAL_ORDER_ISSUE_STATUSES = ['pending', 'awaiting_verification'];

/**
 * Translate a requested status into a query.
 *
 * `expired` is not a stored value — an order lapses by passing its deadline, and
 * this deployment has no scheduler to rewrite the field. So the filter asks for
 * unpaid orders whose deadline has gone by, and the live statuses ask for the
 * ones whose deadline has not. Doing it here rather than with a `setInterval`
 * means the queue cannot show a lapsed order as actionable even if nothing has
 * run in between.
 */
function manualOrderFilter({ status, courseId } = {}) {
  const now = new Date();
  const clauses = [{ provider: 'manual' }];
  const stillLive = { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };

  if (status === 'expired') {
    clauses.push({ status: { $in: MANUAL_ORDER_ISSUE_STATUSES } });
    clauses.push({ expiresAt: { $lte: now } });
  } else if (MANUAL_ORDER_ISSUE_STATUSES.includes(status)) {
    clauses.push({ status });
    clauses.push(stillLive);
  } else if (status) {
    clauses.push({ status });
  }

  if (courseId) clauses.push({ course: courseId });

  // Always an $and, including when there is only the one clause, so that the
  // search below can append to it without having to guess which shape came back.
  return { $and: clauses };
}

/** The counts across the top of the Payments screen. */
router.get(
  '/payments/manual/stats',
  asyncHandler(async (req, res) => {
    const now = new Date();

    const rows = await Payment.aggregate([
      { $match: { provider: 'manual' } },
      {
        $addFields: {
          effectiveStatus: {
            $cond: [
              {
                $and: [
                  { $in: ['$status', MANUAL_ORDER_ISSUE_STATUSES] },
                  { $ne: ['$expiresAt', null] },
                  { $lte: ['$expiresAt', now] },
                ],
              },
              'expired',
              '$status',
            ],
          },
        },
      },
      {
        $group: {
          _id: '$effectiveStatus',
          count: { $sum: 1 },
          totalCents: { $sum: '$amountCents' },
        },
      },
    ]);

    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    const collected = rows
      .filter((row) => row._id === 'paid')
      .reduce((total, row) => total + row.totalCents, 0);

    return ok(res, {
      counts: {
        pending: byStatus.pending || 0,
        awaitingVerification: byStatus.awaiting_verification || 0,
        confirmed: byStatus.paid || 0,
        rejected: byStatus.rejected || 0,
        expired: byStatus.expired || 0,
        totalOrders: rows.reduce((total, row) => total + row.count, 0),
      },
      // Integer cents summed in Mongo, formatted once, never a float.
      collectedCents: collected,
      collectedLabel: formatCents(collected, 'usd'),
      numbers: config.manualPayment.numbers,
    });
  })
);

/** The queue itself. */
router.get(
  '/payments/manual',
  validate({
    query: listQuery.extend({
      courseId: objectId.optional(),
      search: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);
    const { status, courseId, search } = req.valid.query;

    const filter = manualOrderFilter({ status, courseId });

    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');

      /**
       * An email search has to resolve accounts first, because an order holds a
       * reference to a student and not an address. Bounded at 50, so a short
       * substring common to many addresses cannot quietly become a scan of every
       * account on the platform.
       */
      const byEmail = /^WGA-/i.test(search)
        ? []
        : await User.find({ email: pattern }).select('_id').limit(50);

      const or = [
        { orderId: pattern },
        { studentPhone: pattern },
        { paymentReference: pattern },
      ];

      if (byEmail.length) or.push({ student: { $in: byEmail.map((user) => user._id) } });

      filter.$and.push({ $or: or });
    }

    const [orders, total] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments(filter),
    ]);

    const [students, courses] = await Promise.all([
      User.find({ _id: { $in: orders.map((order) => order.student) } }).select('firstName lastName email'),
      Course.find({ _id: { $in: orders.map((order) => order.course) } }).select('title slug'),
    ]);

    const studentById = new Map(students.map((student) => [String(student._id), student]));
    const courseById = new Map(courses.map((course) => [String(course._id), course]));

    return ok(res, {
      ...paginated(
        orders.map((order) => {
          const student = studentById.get(String(order.student));
          const course = courseById.get(String(order.course));
          return {
            ...order.toJSONForOwner(),
            courseTitle: course ? course.title : null,
            studentName: student ? `${student.firstName || ''} ${student.lastName || ''}`.trim() : null,
            studentEmail: student ? student.email : null,
            studentPhone: order.studentPhone,
            paidToNumber: order.paidToNumber,
            paymentReference: order.paymentReference,
            notes: order.notes,
            markedPaidAt: order.markedPaidAt,
            expiresAt: order.expiresAt,
            createdAt: order.createdAt,
          };
        }),
        total,
        { page, limit }
      ),
    });
  })
);

/**
 * The money is in the account, so let the student in.
 *
 * Confirm is a POST rather than a PATCH because it is not idempotent in the
 * sense that matters: it grants access. Pressing it twice is safe — the service
 * returns early and the enrolment is not duplicated — but calling it once has a
 * consequence a caller should have to intend.
 */
router.post(
  '/payments/manual/:orderId/verify',
  writeLimiter,
  validate({
    params: z.object({ orderId: orderRef }),
    body: z.object({ notes: z.string().trim().max(2000).optional().nullable() }),
  }),
  asyncHandler(async (req, res) => {
    const order = await paymentService.findManualOrder(req.valid.params.orderId);
    if (!order) throw notFound('That order could not be found.', { code: 'ORDER_NOT_FOUND' });

    const result = await paymentService.confirmManualOrder({
      payment: order,
      adminUser: req.user,
      notes: req.valid.body.notes || null,
    });

    /**
     * Anything other than a completed settlement is reported as a failure.
     * Telling an administrator "confirmed" when the enrolment was not created
     * would leave a student locked out of a course that has been paid for.
     */
    if (!result.handled) {
      logger.error('manual order could not be confirmed', {
        orderId: order.orderId,
        reason: result.reason,
      });
      throw conflict(
        `The order could not be completed (${result.reason}). The student may have been deleted, or the course removed.`,
        { code: 'CONFIRM_FAILED' }
      );
    }

    const fresh = await Payment.findById(order._id);

    /**
     * One confirmation, two possible outcomes, and the administrator has to be
     * told which one happened — "the student enrolled" after issuing a
     * certificate would leave them unsure whether anything did.
     */
    const isCertificate = (order.purpose || 'enrollment') === 'certificate';

    return ok(
      res,
      { order: fresh.toJSONForOwner(), outcome: isCertificate ? 'certificate' : 'enrollment' },
      result.reason === 'already_fulfilled'
        ? 'That order had already been confirmed. Nothing was changed.'
        : isCertificate
          ? 'Payment confirmed and the certificate has been issued.'
          : 'Payment confirmed and the student enrolled.'
    );
  })
);

router.post(
  '/payments/manual/:orderId/reject',
  writeLimiter,
  validate({
    params: z.object({ orderId: orderRef }),
    // A reason is required: the student is shown it, and "rejected" with no
    // explanation generates a support message every time.
    body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }),
  }),
  asyncHandler(async (req, res) => {
    const order = await paymentService.findManualOrder(req.valid.params.orderId);
    if (!order) throw notFound('That order could not be found.', { code: 'ORDER_NOT_FOUND' });

    const { payment } = await paymentService.rejectManualOrder({
      payment: order,
      adminUser: req.user,
      reason: req.valid.body.reason,
    });

    return ok(res, { order: payment.toJSONForOwner() }, 'Order rejected.');
  })
);

/**
 * Turn an announcement link into something clickable.
 *
 * The address was built by appending whatever was typed to the base URL, so an
 * absolute link became `https://sitehttps://example.com` — a dead button in every
 * recipient's inbox. An absolute address is now passed through, and a path is
 * resolved against the site.
 */
function announcementLink(link) {
  if (!link) return undefined;
  if (/^https?:\/\//i.test(link)) return link;
  return `${config.publicBaseUrl}${link.startsWith('/') ? '' : '/'}${link}`;
}

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
      /**
       * A link people will click in an email, so it must be one of two shapes:
       * an absolute http(s) address, or a path on this site. Anything else —
       * `javascript:`, a bare word — is refused here rather than delivered.
       */
      link: z
        .string()
        .trim()
        .max(500)
        .refine(
          (value) => value === '' || /^https?:\/\//i.test(value) || value.startsWith('/'),
          'Use a full address starting with http:// or https://, or a path starting with /'
        )
        .optional(),
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
      const linkUrl = announcementLink(body.link);

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
                url: linkUrl,
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
      status: z.enum(['issued', 'revoked', 'pending_payment']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    /**
     * `$ne` rather than `=== 'issued'` on purpose: a certificate created before
     * this field existed has no stored status, and belongs with the issued ones.
     */
    const filter = {};
    if (query.status === 'issued') {
      filter.revokedAt = null;
      filter.status = { $ne: 'pending_payment' };
    }
    if (query.status === 'revoked') filter.revokedAt = { $ne: null };
    if (query.status === 'pending_payment') {
      filter.revokedAt = null;
      filter.status = 'pending_payment';
    }

    if (query.q) {
      const pattern = contains(query.q);
      filter.$or = [{ certificateNumber: pattern }, { studentName: pattern }, { courseTitle: pattern }];
    }

    const [certificates, total, issued, revoked, pendingPayment] = await Promise.all([
      Certificate.find(filter).sort({ issueDate: -1 }).skip(skip).limit(limit),
      Certificate.countDocuments(filter),
      Certificate.countDocuments({ revokedAt: null, status: { $ne: 'pending_payment' } }),
      Certificate.countDocuments({ revokedAt: { $ne: null } }),
      Certificate.countDocuments({ revokedAt: null, status: 'pending_payment' }),
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
      counts: { issued, revoked, pendingPayment, total: issued + revoked + pendingPayment },
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

/* ------------------------------------------------------------------ *
 * Enquiries and newsletter subscribers — the two things the public pages
 * collect that nothing could read
 * ------------------------------------------------------------------ */

/**
 * The contact form and the newsletter form have always written to the database,
 * and the contact form also tries to send a notification email. Until now there
 * was no endpoint and no screen that read either collection back: the records
 * accumulated where only somebody with direct database access could find them.
 *
 * That is survivable while email delivery works and both forms copy the academy,
 * and it is not survivable when it does not. `notifiedAt` on each message records
 * whether the email actually went out; this endpoint is how an administrator
 * finds the ones where it did not.
 */

const enquiryQuery = z.object({
  state: z.enum(['open', 'handled', 'all']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.get(
  '/enquiries',
  validate({ query: enquiryQuery }),
  asyncHandler(async (req, res) => {
    const { state = 'open' } = req.valid.query;
    const { limit, page, skip } = parsePagination(req.valid.query);

    // `handledAt: null` matches documents where the field is absent too, which
    // is what messages written before the field existed look like.
    const filter = state === 'all' ? {} : { handledAt: state === 'handled' ? { $ne: null } : null };

    const [total, messages] = await Promise.all([
      ContactMessage.countDocuments(filter),
      ContactMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);

    return ok(
      res,
      paginated(
        messages.map((message) => ({
          id: String(message._id),
          name: message.name,
          email: message.email,
          reason: message.reason,
          subject: message.subject,
          message: message.message,
          createdAt: message.createdAt,
          notifiedAt: message.notifiedAt,
          handledAt: message.handledAt,
        })),
        total,
        { page, limit }
      )
    );
  })
);

router.patch(
  '/enquiries/:id',
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ handled: z.boolean() }),
  }),
  asyncHandler(async (req, res) => {
    const message = await ContactMessage.findById(req.valid.params.id);
    if (!message) throw notFound('That enquiry could not be found.', { code: 'ENQUIRY_NOT_FOUND' });

    message.handledAt = req.valid.body.handled ? message.handledAt || new Date() : null;
    await message.save();

    return ok(
      res,
      { id: String(message._id), handledAt: message.handledAt },
      message.handledAt ? 'Marked as handled.' : 'Reopened.'
    );
  })
);

router.get(
  '/subscribers',
  asyncHandler(async (req, res) => {
    // Read straight from `req.query`: this route takes only page and limit, and
    // parsePagination already clamps both, so there is nothing to validate.
    const { limit, page, skip } = parsePagination(req.query);

    const [total, active, subscribers] = await Promise.all([
      NewsletterSubscriber.countDocuments({}),
      NewsletterSubscriber.countDocuments({ unsubscribedAt: null }),
      NewsletterSubscriber.find({}).sort({ subscribedAt: -1 }).skip(skip).limit(limit),
    ]);

    return ok(res, {
      ...paginated(
        subscribers.map((subscriber) => ({
          id: String(subscriber._id),
          email: subscriber.email,
          source: subscriber.source,
          subscribedAt: subscriber.subscribedAt,
          unsubscribedAt: subscriber.unsubscribedAt,
        })),
        total,
        { page, limit }
      ),
      total,
      active,
    });
  })
);

/* ------------------------------------------------------------------ *
 * Reviews
 *
 * A review is written by a student and published only after an administrator
 * has read it. The queue is the only place a pending review is readable, so the
 * routes below deliberately do not reuse the student-facing serialiser: that one
 * hides the text of an unapproved review, which is exactly what a moderator
 * needs to see.
 * ------------------------------------------------------------------ */

async function courseIndexFor(reviews) {
  const ids = [...new Set(reviews.map((review) => String(review.course)))];
  const courses = await Course.find({ _id: { $in: ids } }).select('title slug');

  return new Map(courses.map((course) => [String(course._id), course]));
}

function reviewForModeration(review, courses) {
  const course = courses.get(String(review.course));

  return {
    id: String(review._id),
    courseId: String(review.course),
    courseTitle: course ? course.title : '',
    courseSlug: course ? course.slug : null,
    rating: review.rating,
    title: review.title,
    body: review.body,
    status: review.status,
    author: {
      id: String(review.student),
      name: review.studentName || 'A student',
      avatarUrl: review.studentAvatar || null,
    },
    moderationNote: review.moderationNote,
    moderatedAt: review.moderatedAt,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

router.get(
  '/reviews',
  validate({ query: reviewSchemas.listModerationQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, skip } = parsePagination(query);

    const filter = {};
    if (query.status !== 'all') filter.status = query.status;
    if (query.courseId) filter.course = query.courseId;

    const [reviews, total, pending, approved, rejected] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Review.countDocuments(filter),
      Review.countDocuments({ status: 'pending' }),
      Review.countDocuments({ status: 'approved' }),
      Review.countDocuments({ status: 'rejected' }),
    ]);

    const courses = await courseIndexFor(reviews);

    return ok(res, {
      ...paginated(
        reviews.map((review) => reviewForModeration(review, courses)),
        total,
        { page, limit }
      ),
      counts: { pending, approved, rejected },
    });
  })
);

/** Shared by approve and reject: settle the course score, then tell the author. */
async function decideReview(review, { status, note, req, message }) {
  review.status = status;
  review.moderationNote = note || null;
  review.moderatedBy = req.user._id;
  review.moderatedAt = new Date();
  await review.save();

  await recomputeCourseRating(review.course);

  const course = await Course.findById(review.course).select('title slug');

  try {
    await notifications.notify(review.student, {
      title: status === 'approved' ? 'Your review is live' : 'Your review was not published',
      message,
      type: 'system',
      link: course ? `/course.html?course=${course.slug}&tab=reviews` : null,
      meta: { reviewId: String(review._id) },
    });
  } catch (error) {
    // The decision stands whether or not the student can be told about it.
    logger.error('review decision notification failed', {
      error,
      reviewId: String(review._id),
    });
  }

  const courses = await courseIndexFor([review]);
  return reviewForModeration(review, courses);
}

router.post(
  '/reviews/:id/approve',
  writeLimiter,
  validate({ params: reviewSchemas.reviewIdParam }),
  asyncHandler(async (req, res) => {
    const review = await Review.findById(req.valid.params.id);
    if (!review) throw notFound('That review could not be found.', { code: 'REVIEW_NOT_FOUND' });

    const result = await decideReview(review, {
      status: 'approved',
      note: null,
      req,
      message: 'Your review has been checked and now appears on the course page.',
    });

    return ok(res, { review: result }, 'Review published.');
  })
);

router.post(
  '/reviews/:id/reject',
  writeLimiter,
  validate({ params: reviewSchemas.reviewIdParam, body: reviewSchemas.rejectReviewBody }),
  asyncHandler(async (req, res) => {
    const review = await Review.findById(req.valid.params.id);
    if (!review) throw notFound('That review could not be found.', { code: 'REVIEW_NOT_FOUND' });

    const reason = req.valid.body.reason;

    const result = await decideReview(review, {
      status: 'rejected',
      note: reason,
      req,
      message: `Your review was not published. ${reason}`,
    });

    return ok(res, { review: result }, 'Review sent back to the student.');
  })
);

router.delete(
  '/reviews/:id',
  writeLimiter,
  validate({ params: reviewSchemas.reviewIdParam }),
  asyncHandler(async (req, res) => {
    const review = await Review.findByIdAndDelete(req.valid.params.id);
    if (!review) throw notFound('That review could not be found.', { code: 'REVIEW_NOT_FOUND' });

    await recomputeCourseRating(review.course);

    return ok(res, null, 'Review removed.');
  })
);

module.exports = router;
