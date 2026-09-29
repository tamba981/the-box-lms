'use strict';

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Lesson = require('../models/Lesson');
const User = require('../models/User');

const certificateService = require('./certificateService');
const notifications = require('./notificationService');
const email = require('./email');
const logger = require('../lib/logger');

const config = require('../config/env');
const { badRequest, conflict, notFound } = require('../lib/errors');

/**
 * The learning loop: enrolling, reading lessons, completing them, and issuing a
 * certificate when a course is finished.
 */

const courseLink = (course) => `/student-dashboard.html#/course/${course.slug || course._id}`;
const lessonLink = (course, lesson) => `${courseLink(course)}/lesson/${lesson._id}`;

/* ------------------------------------------------------------------ *
 * Enrollment
 * ------------------------------------------------------------------ */

/**
 * Enrol a student, idempotently.
 *
 * The unique (student, course) index is the real guarantee: if two identical
 * requests arrive together, one insert wins and the other is caught and turned
 * into "here is the enrollment you already have" rather than a 500. A retry,
 * a double-clicked button and a redelivered webhook all land here safely.
 */
async function enroll({ user, course, source = 'free', payment = null }) {
  if (course.status !== 'published' && user.role !== 'admin') {
    throw notFound('That course is not open for enrollment.', { code: 'COURSE_NOT_PUBLISHED' });
  }

  if (course.priceCents > 0 && source === 'free') {
    throw conflict('This is a paid course. Please complete payment to enroll.', {
      code: 'PAYMENT_REQUIRED',
      details: [{ field: 'courseId', message: 'Paid course' }],
    });
  }

  if (String(course.instructor) === String(user._id)) {
    throw badRequest('You cannot enroll in a course you teach.', { code: 'OWN_COURSE' });
  }

  const existing = await Enrollment.findOne({ student: user._id, course: course._id });
  if (existing) {
    // Re-enrolling after cancelling restores access without a second count.
    if (existing.status === 'cancelled') {
      existing.status = 'active';
      existing.source = source;
      existing.payment = payment ? payment._id : existing.payment;
      existing.lastAccessedAt = new Date();
      await existing.save();

      await Course.updateOne({ _id: course._id }, { $inc: { enrolledCount: 1 } });
    }
    return { enrollment: existing, created: false };
  }

  let enrollment;

  try {
    enrollment = await Enrollment.create({
      student: user._id,
      course: course._id,
      courseTitle: course.title,
      status: 'active',
      source,
      payment: payment ? payment._id : null,
      lastAccessedAt: new Date(),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const raced = await Enrollment.findOne({ student: user._id, course: course._id });
      if (raced) return { enrollment: raced, created: false };
    }
    throw error;
  }

  await Course.updateOne({ _id: course._id }, { $inc: { enrolledCount: 1 } });

  notifications
    .onEnrollment(user._id, course, courseLink(course))
    .catch((error) => logger.error('enrollment notification failed', { error }));

  setImmediate(async () => {
    try {
      await email.deliver(email.enrollmentEmail({ user, course, free: source === 'free' }));
    } catch (error) {
      logger.error('enrollment email failed', { error });
    }
  });

  return { enrollment, created: true };
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * Recompute an enrollment's progress from its completed lessons.
 *
 * The percentage is always derived from the lesson list rather than
 * incremented, so it cannot drift: unpublishing a lesson or clearing a
 * completion is reflected immediately, and the number can never exceed 100 or
 * disagree with the tick marks a student sees.
 */
async function recalculate(enrollment, course) {
  const lessons = await Lesson.find({ course: course._id, published: true }).select('_id durationMinutes');

  const publishedIds = lessons.map((lesson) => String(lesson._id));
  const completed = new Set(enrollment.completedLessons.map(String));
  const completedPublished = publishedIds.filter((id) => completed.has(id));

  const total = publishedIds.length;
  const progress = total === 0 ? 0 : Math.round((completedPublished.length / total) * 100);

  const minutes = lessons
    .filter((lesson) => completed.has(String(lesson._id)))
    .reduce((sum, lesson) => sum + (lesson.durationMinutes || 0), 0);

  enrollment.progress = progress;
  enrollment.hoursSpent = Math.round((minutes / 60) * 10) / 10;

  const finished = total > 0 && completedPublished.length === total;

  if (finished && enrollment.status !== 'completed') {
    enrollment.status = 'completed';
    enrollment.completedAt = new Date();
  } else if (!finished && enrollment.status === 'completed') {
    // A lesson was added or restored after the course was completed.
    enrollment.status = 'active';
    enrollment.completedAt = null;
  }

  await enrollment.save();

  return { progress, total, completedCount: completedPublished.length, finished };
}

/**
 * Mark a lesson complete for a student.
 *
 * `$addToSet` makes a repeated completion a no-op rather than an error, which
 * matters because the player will fire this on every visit to a finished
 * lesson.
 */
async function completeLesson({ user, course, lessonId }) {
  const enrollment = await Enrollment.findOne({
    student: user._id,
    course: course._id,
    status: { $ne: 'cancelled' },
  });

  if (!enrollment) throw notFound('You are not enrolled in this course.', { code: 'NOT_ENROLLED' });

  const lesson = await Lesson.findOne({ _id: lessonId, course: course._id });
  if (!lesson) throw notFound('That lesson could not be found.', { code: 'LESSON_NOT_FOUND' });

  await Enrollment.updateOne(
    { _id: enrollment._id },
    {
      $addToSet: { completedLessons: lesson._id },
      $set: { lastAccessedAt: new Date(), lastLesson: lesson._id },
    }
  );

  const fresh = await Enrollment.findById(enrollment._id);
  const state = await recalculate(fresh, course);

  let certificate = null;

  if (state.finished) {
    const student = await User.findById(user._id);
    certificate = await certificateService.issueFor(fresh, course, student);
    fresh.certificate = certificate._id;

    if (certificate && certificate.issueDate.getTime() > Date.now() - 60000) {
      notifications
        .onCertificate(user._id, certificate, `/student-dashboard.html#/certificates`)
        .catch((error) => logger.error('certificate notification failed', { error }));

      setImmediate(async () => {
        try {
          await email.deliver(email.certificateEmail({ user: student, certificate }));
        } catch (error) {
          logger.error('certificate email failed', { error });
        }
      });
    }
  }

  return { enrollment: fresh, certificate, lesson, ...state };
}

/** Remove a completion, used when a student un-ticks a lesson. */
async function uncompleteLesson({ user, course, lessonId }) {
  const enrollment = await Enrollment.findOne({
    student: user._id,
    course: course._id,
    status: { $ne: 'cancelled' },
  });

  if (!enrollment) throw notFound('You are not enrolled in this course.', { code: 'NOT_ENROLLED' });

  await Enrollment.updateOne({ _id: enrollment._id }, { $pull: { completedLessons: lessonId } });

  const fresh = await Enrollment.findById(enrollment._id);
  const state = await recalculate(fresh, course);

  return { enrollment: fresh, ...state };
}

/** Keep the denormalised `courseTitle` accurate when a course is renamed. */
async function syncCourseTitle(course) {
  await Enrollment.updateMany({ course: course._id }, { $set: { courseTitle: course.title } });
}

module.exports = {
  enroll,
  recalculate,
  completeLesson,
  uncompleteLesson,
  syncCourseTitle,
  courseLink,
  lessonLink,
};
