'use strict';

const express = require('express');

const Course = require('../models/Course');

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
 * One aggregation, because five `countDocuments` calls for a footer statistic is
 * four too many. Only published courses are counted, which is what a visitor can
 * actually enrol in.
 */
router.get(
  '/public',
  asyncHandler(async (req, res) => {
    const [row] = await Course.aggregate([
      { $match: { status: 'published' } },
      {
        $group: {
          _id: null,
          courses: { $sum: 1 },
          lessons: { $sum: '$lessonCount' },
          hours: { $sum: '$durationHours' },
          freeCourses: { $sum: { $cond: [{ $eq: ['$priceCents', 0] }, 1, 0] } },
          // A course with no instructor name is not a taught course, and counting
          // the empty string as an instructor inflates the figure by one.
          instructors: {
            $addToSet: {
              $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$instructorName', ''] } }, 0] }, '$instructorName', '$$REMOVE'],
            },
          },
        },
      },
      { $project: { courses: 1, lessons: 1, hours: 1, freeCourses: 1, instructorCount: { $size: '$instructors' } } },
    ]);

    const stats = row || { courses: 0, lessons: 0, hours: 0, freeCourses: 0, instructorCount: 0 };

    return ok(
      res,
      {
        courses: stats.courses,
        instructors: stats.instructorCount,
        lessons: stats.lessons,
        hours: Math.round(stats.hours || 0),
        freeCourses: stats.freeCourses,
      },
      'OK'
    );
  })
);

module.exports = router;
