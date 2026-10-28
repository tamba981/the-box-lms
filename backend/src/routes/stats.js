'use strict';

const express = require('express');

const Course = require('../models/Course');
const User = require('../models/User');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');

const router = express.Router();

/**
 * GET /api/v1/stats/public — how big the catalogue is.
 *
 * The homepage states these numbers, and they have to be counted rather than
 * written down: the page claimed a fixed set of figures, and every one of them
 * went stale the moment a course was added or unpublished.
 *
 * Both figures are counted on every request, so approving an instructor,
 * suspending one, publishing a course or deleting one shows up on the next load.
 *
 * Courses are counted only when published — that is what a visitor can actually
 * enrol in. Instructors are counted from the accounts, not from the courses: a
 * newly approved instructor who has not written a course yet is still an
 * instructor, and the old figure — distinct instructor names across published
 * courses — reported one for an academy that has two.
 */
router.get(
  '/public',
  asyncHandler(async (req, res) => {
    const [rows, instructors] = await Promise.all([
      Course.aggregate([
        { $match: { status: 'published' } },
        {
          $group: {
            _id: null,
            courses: { $sum: 1 },
            lessons: { $sum: '$lessonCount' },
            hours: { $sum: '$durationHours' },
            freeCourses: { $sum: { $cond: [{ $eq: ['$priceCents', 0] }, 1, 0] } },
          },
        },
      ]),
      /**
       * An instructor counts while the account is active. Suspending one drops
       * them from the figure immediately, and deleting the account does the same
       * because there is no document left to count.
       */
      User.countDocuments({ role: 'instructor', status: 'active' }),
    ]);

    const stats = rows[0] || { courses: 0, lessons: 0, hours: 0, freeCourses: 0 };

    // Short enough that a change lands promptly, long enough that a visitor
    // refreshing repeatedly does not re-count the catalogue each time.
    res.set('Cache-Control', 'public, max-age=30');

    return ok(
      res,
      {
        courses: stats.courses,
        instructors,
        lessons: stats.lessons,
        hours: Math.round(stats.hours || 0),
        freeCourses: stats.freeCourses,
      },
      'OK'
    );
  })
);

module.exports = router;
