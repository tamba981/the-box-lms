'use strict';

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const { forbidden, notFound } = require('./errors');

/**
 * The single source of truth for "who may do what to a course".
 *
 * Every access decision in the API goes through here rather than being
 * re-derived in each route, so a rule can only be got wrong in one place.
 */

/** Look a course up by either its ObjectId or its slug. */
async function findCourse(identifier) {
  if (!identifier) return null;

  const isObjectId = /^[a-f\d]{24}$/i.test(String(identifier));
  const query = isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() };

  return Course.findOne(query);
}

/**
 * Load a course or fail with a 404. A draft that the viewer has no right to see
 * is reported as 404 rather than 403, so the existence of unpublished courses
 * is not disclosed.
 */
async function loadVisibleCourse(identifier, viewer) {
  const course = await findCourse(identifier);
  if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

  const maySeeUnpublished =
      viewer && (viewer.role === 'admin' || instructorIdOf(course) === String(viewer._id));
  if (course.status !== 'published' && !maySeeUnpublished) {
    throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
  }

  return course;
}

/**
 * The instructor's id, whether the field holds an id or a populated document.
 *
 * `course.instructor` is a ref, so it is normally an ObjectId. But the course
 * detail route populates it into a full User document so the page can show a real
 * author card — and a populated document stringifies to "[object Object]", never
 * matching a user id. Comparing the raw field therefore reported `manages: false`
 * to a course's own instructor, which left them looking at their own course as a
 * stranger: a padlock on every lesson, no Manage button, and their unpublished
 * lessons hidden from the very page they were meant to be authoring from.
 */
function instructorIdOf(course) {
  const value = course && course.instructor;
  if (!value) return null;
  return String(value._id || value.id || value);
}

/** Admins manage everything; an instructor manages only their own courses. */
function canManageCourse(user, course) {
  if (!user || !course) return false;
  if (user.role === 'admin') return true;
  return user.role === 'instructor' && instructorIdOf(course) === String(user._id);
}

function assertCanManageCourse(user, course) {
  if (!canManageCourse(user, course)) {
    throw forbidden('You can only manage courses you created.', { code: 'NOT_COURSE_OWNER' });
  }
}

async function findEnrollment(userId, courseId) {
  if (!userId || !courseId) return null;
  return Enrollment.findOne({ student: userId, course: courseId, status: { $ne: 'cancelled' } });
}

/**
 * Whether a viewer may read lesson bodies (as opposed to just the outline).
 * A preview lesson is readable by anyone; everything else needs an enrollment.
 */
async function resolveCourseAccess(viewer, course, options = {}) {
  const manages = canManageCourse(viewer, course);
  const enrollment = viewer ? await findEnrollment(viewer._id, course._id) : null;

  const canReadContent = Boolean(manages || enrollment);
  const canEnroll =
    Boolean(viewer) &&
    !manages &&
    !enrollment &&
    viewer.role === 'student' &&
    course.status === 'published';

  return {
    course,
    enrollment,
    manages,
    isEnrolled: Boolean(enrollment),
    canReadContent,
    canEnroll,
    isFree: course.priceCents === 0,
    // A paid course needs a completed payment before enrollment exists.
    requiresPayment: course.priceCents > 0,
    ...(options.extra || {}),
  };
}

/**
 * Mark an enrollment's owning student as the only non-admin who may read it.
 * Instructors of a course also need access to a student's progress for grading.
 */
function assertOwnsEnrollment(user, enrollment) {
  if (user.role === 'admin') return;
  if (String(enrollment.student) === String(user._id)) return;
  throw forbidden('This is not your enrollment.', { code: 'NOT_ENROLLED' });
}

module.exports = {
  findCourse,
  loadVisibleCourse,
  canManageCourse,
  instructorIdOf,
  assertCanManageCourse,
  findEnrollment,
  resolveCourseAccess,
  assertOwnsEnrollment,
};
