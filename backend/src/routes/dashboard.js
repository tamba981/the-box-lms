'use strict';

const express = require('express');

const Certificate = require('../models/Certificate');
const CommunityPost = require('../models/CommunityPost');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const LiveSession = require('../models/LiveSession');
const Notification = require('../models/Notification');
const Payment = require('../models/Payment');
const Thread = require('../models/Thread');

const { z } = require('zod');

const { asyncHandler } = require('../lib/asyncHandler');
const { normaliseCurrency, summariseRevenueByCurrency } = require('../lib/money');
const { ok } = require('../lib/respond');
const { notFound } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const { preview } = require('../lib/text');

const { authenticate, requireInstructor } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

/** Unread direct-message total for the header badge. */
async function unreadMessageCount(userId) {
  const threads = await Thread.find({ participants: userId }).select('unread');

  return threads.reduce((sum, thread) => sum + thread.unreadFor(userId), 0);
}

/**
 * Dashboard summaries.
 *
 * Each endpoint is one request that answers everything the landing view of a
 * dashboard needs, so a page load is a single round trip rather than eight.
 * All counting is done with aggregations or countDocuments — never by fetching
 * rows and measuring the array in JavaScript.
 */

/* ------------------------------------------------------------------ *
 * GET /api/v1/dashboard/student
 * ------------------------------------------------------------------ */

router.get(
  '/student',
  authenticate,
  asyncHandler(async (req, res) => {
    const studentId = req.user._id;

    const [
      totals,
      continueLearning,
      certificates,
      upcomingSessions,
      recentNotifications,
      unreadCount,
      unreadMessages,
    ] = await Promise.all([
      Enrollment.aggregate([
        { $match: { student: studentId, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: null,
            enrolled: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            inProgress: {
              $sum: { $cond: [{ $and: [{ $gt: ['$progress', 0] }, { $lt: ['$progress', 100] }] }, 1, 0] },
            },
            hours: { $sum: '$hoursSpent' },
            averageProgress: { $avg: '$progress' },
          },
        },
      ]),

      // "Pick up where you left off" — most recently opened, not yet finished.
      Enrollment.find({ student: studentId, status: 'active' })
        .sort({ lastAccessedAt: -1, createdAt: -1 })
        .limit(4)
        .populate({ path: 'course' }),

      Certificate.find({ student: studentId }).sort({ issueDate: -1 }).limit(3),

      LiveSession.find({
        course: {
          $in: (
            await Enrollment.find({ student: studentId, status: { $ne: 'cancelled' } }).select('course')
          ).map((enrollment) => enrollment.course),
        },
        endTime: { $gte: new Date() },
        status: { $ne: 'cancelled' },
      })
        .sort({ startTime: 1 })
        .limit(4),

      Notification.find({ user: studentId }).sort({ createdAt: -1 }).limit(6),

      Notification.countDocuments({ user: studentId, read: false }),

      unreadMessageCount(studentId),
    ]);
    const summary = totals[0] || { enrolled: 0, completed: 0, inProgress: 0, hours: 0, averageProgress: 0 };

    return ok(res, {
      user: req.user.toPublicJSON({ includePrivate: true }),
      stats: {
        enrolled: summary.enrolled,
        completed: summary.completed,
        inProgress: summary.inProgress,
        hoursLearned: Math.round((summary.hours || 0) * 10) / 10,
        averageProgress: Math.round(summary.averageProgress || 0),
        certificates: await Certificate.countDocuments({ student: studentId, revokedAt: null }),
      },
      continueLearning: continueLearning
        .filter((enrollment) => enrollment.course)
        .map((enrollment) => enrollment.toJSONForStudent()),

      certificates: certificates.map((certificate) => certificate.toJSONForOwner()),

      upcomingSessions: upcomingSessions.map((session) => session.toJSONFor(studentId, { canJoin: true })),

      notifications: recentNotifications.map((notification) => ({
        id: String(notification._id),
        title: notification.title,
        message: notification.message,
        type: notification.type,
        link: notification.link,
        read: notification.read,
        createdAt: notification.createdAt,
      })),

      unread: { notifications: unreadCount, messages: unreadMessages },
    });
  })
);

/**
 * GET /api/v1/dashboard/instructor
 */

router.get(
  '/instructor',
  authenticate,
  requireInstructor,
  asyncHandler(async (req, res) => {
    const instructorId = req.user._id;

    const courses = await Course.find({ instructor: instructorId, status: { $ne: 'archived' } })
      .sort({ updatedAt: -1 })
      .limit(12);

    const courseIds = courses.map((course) => course._id);

    // Revenue is summed from completed payments for this instructor's courses.
    // Money is added in integer cents and only formatted at the edge.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [enrollmentStats, upcomingSessions, recentEnrollments, ratings, pendingCount, revenueRows, monthRows, perCourseRows] =
      await Promise.all([
        Enrollment.aggregate([
          { $match: { course: { $in: courseIds }, status: { $ne: 'cancelled' } } },
          {
            $group: {
              _id: null,
              students: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              averageProgress: { $avg: '$progress' },
            },
          },
        ]),

        LiveSession.find({
          instructor: instructorId,
          endTime: { $gte: new Date() },
          status: { $ne: 'cancelled' },
        })
          .sort({ startTime: 1 })
          .limit(5),

        Enrollment.find({ course: { $in: courseIds }, status: { $ne: 'cancelled' } })
          .sort({ createdAt: -1 })
          .limit(6)
          .populate({ path: 'student', select: 'firstName lastName email avatarUrl' }),

        Course.aggregate([
          { $match: { instructor: instructorId, ratingCount: { $gt: 0 } } },
          { $group: { _id: null, sum: { $sum: '$ratingSum' }, count: { $sum: '$ratingCount' } } },
        ]),

        Course.countDocuments({ instructor: instructorId, status: 'pending' }),

        Payment.aggregate([
          { $match: { course: { $in: courseIds }, status: 'paid' } },
          { $group: { _id: '$currency', totalCents: { $sum: '$amountCents' }, payments: { $sum: 1 } } },
        ]),

        Payment.aggregate([
          { $match: { course: { $in: courseIds }, status: 'paid', paidAt: { $gte: monthStart } } },
          { $group: { _id: '$currency', totalCents: { $sum: '$amountCents' }, payments: { $sum: 1 } } },
        ]),

        Payment.aggregate([
          { $match: { course: { $in: courseIds }, status: 'paid' } },
          { $group: { _id: { course: '$course', currency: '$currency' }, totalCents: { $sum: '$amountCents' }, payments: { $sum: 1 } } },
          { $sort: { totalCents: -1 } },
        ]),
      ]);

    const titlesById = new Map(courses.map((course) => [String(course._id), course.title]));

    const summary = enrollmentStats[0] || { students: 0, completed: 0, averageProgress: 0 };
    const rating = ratings[0];

    const totalRevenue = summariseRevenueByCurrency(revenueRows);
    const monthRevenue = summariseRevenueByCurrency(monthRows);

    // One row per course *per currency*. Grouping by course alone would add
    // 1499 USD cents to 1499 EUR cents and call the result 2998 — a number that
    // corresponds to no currency at all.
    const byCourse = new Map();
    perCourseRows.forEach((row) => {
      const courseId = String(row._id.course);
      const currency = normaliseCurrency(row._id.currency);

      if (!byCourse.has(courseId)) {
        byCourse.set(courseId, { courseId, title: titlesById.get(courseId) || 'Course', rows: [] });
      }
      byCourse.get(courseId).rows.push({
        currency,
        totalCents: row.totalCents,
        payments: row.payments,
      });
    });

    return ok(res, {
      user: req.user.toPublicJSON({ includePrivate: true }),

      stats: {
        courses: courses.length,
        published: courses.filter((course) => course.status === 'published').length,
        drafts: courses.filter((course) => course.status === 'draft').length,
        pending: pendingCount,
        students: summary.students,
        completions: summary.completed,
        averageProgress: Math.round(summary.averageProgress || 0),
        averageRating: rating && rating.count ? Math.round((rating.sum / rating.count) * 10) / 10 : 0,
        ratingCount: rating ? rating.count : 0,
        // Completion rate as a percentage, or null when there are no students
        // yet — 0% would read as "nobody finishes", which is a different fact.
        completionRate: summary.students
          ? Math.round((summary.completed / summary.students) * 100)
          : null,
      },

      revenue: {
        totalCents: totalRevenue.totalCents,
        totalLabel: totalRevenue.totalLabel,
        payments: totalRevenue.payments,
        currency: totalRevenue.currency,
        mixedCurrency: totalRevenue.mixedCurrency,
        currencies: totalRevenue.currencies,
        monthlyCents: monthRevenue.totalCents,
        monthlyLabel: monthRevenue.totalLabel,
        monthlyPayments: monthRevenue.payments,
        monthlyMixedCurrency: monthRevenue.mixedCurrency,
        monthlyCurrencies: monthRevenue.currencies,
        // Per-course totals, so the earnings page charts real money rather than
        // a placeholder series.
        byCourse: Array.from(byCourse.values()).map((entry) => {
          const folded = summariseRevenueByCurrency(entry.rows);
          return {
            courseId: entry.courseId,
            title: entry.title,
            totalCents: folded.totalCents,
            totalLabel: folded.totalLabel,
            payments: folded.payments,
            currency: folded.currency,
            mixedCurrency: folded.mixedCurrency,
            currencies: folded.currencies,
          };
        }),
      },

      courses: courses.map((course) => course.toCardJSON()),

      upcomingSessions: upcomingSessions.map((session) =>
        session.toJSONFor(instructorId, { canJoin: true })
      ),

      recentEnrollments: recentEnrollments.map((enrollment) => ({
        id: String(enrollment._id),
        student: enrollment.student
          ? {
              id: String(enrollment.student._id),
              name: `${enrollment.student.firstName} ${enrollment.student.lastName}`,
              email: enrollment.student.email,
              avatarUrl: enrollment.student.avatarUrl,
            }
          : null,
        courseTitle: enrollment.courseTitle,
        courseId: String(enrollment.course),
        progress: enrollment.progress,
        enrolledAt: enrollment.createdAt,
      })),
    });
  })
);

/**
 * GET /api/v1/dashboard/instructor/students
 *
 * Every student enrolled in any of this instructor's courses, with the course
 * they are on. Kept off the main dashboard payload because it is a full list,
 * not a summary, and only the students page needs it.
 */
router.get(
  '/instructor/students',
  authenticate,
  requireInstructor,
  validate({
    query: z.object({
      courseId: z.string().trim().regex(/^[a-f\d]{24}$/i).optional(),
      status: z.enum(['active', 'completed', 'cancelled']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const owned = await Course.find({ instructor: req.user._id }).select('_id title');
    const ownedIds = owned.map((course) => String(course._id));
    const titlesById = new Map(owned.map((course) => [String(course._id), course.title]));

    // A course filter is only honoured if the course is actually theirs.
    if (query.courseId && !ownedIds.includes(String(query.courseId))) {
      throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
    }

    const filter = {
      course: query.courseId ? query.courseId : { $in: owned.map((course) => course._id) },
      status: query.status || { $ne: 'cancelled' },
    };

    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter)
        .sort({ lastAccessedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'student', select: 'firstName lastName email avatarUrl' }),
      Enrollment.countDocuments(filter),
    ]);

    const items = enrollments
      .filter((enrollment) => enrollment.student)
      .map((enrollment) => ({
        id: String(enrollment._id),
        studentId: String(enrollment.student._id),
        name: `${enrollment.student.firstName} ${enrollment.student.lastName}`.trim(),
        email: enrollment.student.email,
        avatarUrl: enrollment.student.avatarUrl,
        courseId: String(enrollment.course),
        courseTitle: titlesById.get(String(enrollment.course)) || enrollment.courseTitle || 'Course',
        progress: enrollment.progress,
        status: enrollment.status,
        hoursSpent: enrollment.hoursSpent,
        enrolledAt: enrollment.createdAt,
        lastActive: enrollment.lastAccessedAt,
        completedAt: enrollment.completedAt,
      }));

    // The search box filters what has been loaded, which is reported back so the
    // page can say so rather than implying it searched everything.
    const searched = query.q
      ? items.filter((item) =>
          `${item.name} ${item.email} ${item.courseTitle}`.toLowerCase().includes(query.q.toLowerCase())
        )
      : items;

    return ok(res, {
      ...paginated(searched, total, { page, limit }),
      courses: owned.map((course) => ({ id: String(course._id), title: course.title })),
      searchedClientSide: Boolean(query.q),
    });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/dashboard/activity — shared activity feed
 * ------------------------------------------------------------------ */

router.get(
  '/activity',
  authenticate,
  asyncHandler(async (req, res) => {
    const enrollments = await Enrollment.find({
      student: req.user._id,
      status: { $ne: 'cancelled' },
    })
      .sort({ lastAccessedAt: -1 })
      .limit(20)
      .select('course');

    const courseIds = enrollments.map((enrollment) => enrollment.course);

    const [posts, courses] = await Promise.all([
      CommunityPost.find({ course: { $in: courseIds }, deletedAt: null }).sort({ createdAt: -1 }).limit(6),
      Course.find({ _id: { $in: courseIds } }).select('title'),
    ]);

    const titles = new Map(courses.map((course) => [String(course._id), course.title]));

    return ok(res, {
      discussions: posts.map((post) =>
        post.toJSONForViewer(req.user._id, {
          courseTitle: titles.get(String(post.course)) || null,
          excerpt: preview(post.content, 160),
        })
      ),
    });
  })
);

module.exports = router;
