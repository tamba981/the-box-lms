'use strict';

const Review = require('../models/Review');
const Course = require('../models/Course');

/**
 * Rebuild a course's rating from its approved reviews.
 *
 * The counters on the course are denormalised so the catalogue never has to
 * aggregate, which means every write that can change a review's visibility has
 * to call this. Recomputing from the reviews rather than incrementing means a
 * missed call cannot leave the score permanently wrong, and removing a review
 * needs no arithmetic of its own.
 */
async function recomputeCourseRating(courseId) {
  const [stats] = await Review.aggregate([
    { $match: { course: courseId, status: 'approved' } },
    { $group: { _id: null, ratingSum: { $sum: '$rating' }, ratingCount: { $sum: 1 } } },
  ]);

  const ratingSum = stats ? stats.ratingSum : 0;
  const ratingCount = stats ? stats.ratingCount : 0;

  await Course.updateOne({ _id: courseId }, { $set: { ratingSum, ratingCount } });

  return { ratingSum, ratingCount };
}

/** The star breakdown shown beside the average on the course page. */
async function ratingSummary(courseId) {
  const rows = await Review.aggregate([
    { $match: { course: courseId, status: 'approved' } },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;

  for (const row of rows) {
    distribution[row._id] = row.count;
    count += row.count;
    sum += row._id * row.count;
  }

  return {
    average: count ? Math.round((sum / count) * 10) / 10 : 0,
    count,
    distribution,
  };
}

module.exports = { recomputeCourseRating, ratingSummary };
