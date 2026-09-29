'use strict';

const mongoose = require('mongoose');

const { ENROLLMENT_STATUSES } = require('../lib/constants');
const { baseOptions } = require('./common');

const enrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'active', index: true },

    /** 0–100, recomputed from completedLessons on every change. */
    progress: { type: Number, default: 0, min: 0, max: 100 },

    /**
     * Lesson ids the student has finished. Stored as an array rather than a
     * counter so that completing the same lesson twice is idempotent: `$addToSet`
     * cannot double-count, and the progress number can always be rebuilt from
     * the truth rather than trusted.
     */
    completedLessons: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    hoursSpent: { type: Number, default: 0, min: 0 },

    lastAccessedAt: { type: Date, default: null },
    lastLesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
    completedAt: { type: Date, default: null },

    certificate: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', default: null },

    /** How access was obtained — a free course or a completed payment. */
    source: { type: String, enum: ['free', 'stripe', 'admin'], default: 'free' },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },

    /** Denormalised so a student's course list renders in one query. */
    courseTitle: { type: String, trim: true, default: '' },
  },
  baseOptions
);

/**
 * One enrollment per student per course. This is the single most important
 * constraint in the system: it is what makes "enroll" safe to retry and what
 * stops a double payment creating two entitlements.
 */
enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
enrollmentSchema.index({ student: 1, status: 1, lastAccessedAt: -1 });
enrollmentSchema.index({ course: 1, status: 1, createdAt: -1 });

enrollmentSchema.methods.toJSONForStudent = function toJSONForStudent(extra = {}) {
  const course = this.course && this.course.toCardJSON ? this.course.toCardJSON() : undefined;

  /**
   * The course's instructor, exposed so a student can start a conversation with
   * the person teaching them. `course.instructor` is an id unless the caller
   * populated it, so both shapes are handled.
   */
  const instructor = this.course && this.course.instructor;
  const instructorId = instructor
    ? String(instructor._id || instructor)
    : null;

  return {
    id: String(this._id),
    courseId: String(this.course && this.course._id ? this.course._id : this.course),
    course,
    instructorId,
    status: this.status,
    progress: this.progress,
    completedLessonIds: this.completedLessons.map(String),
    completedCount: this.completedLessons.length,
    hoursSpent: this.hoursSpent,
    lastAccessedAt: this.lastAccessedAt,
    lastLessonId: this.lastLesson ? String(this.lastLesson) : null,
    completedAt: this.completedAt,
    certificateId: this.certificate ? String(this.certificate) : null,
    enrolledAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model('Enrollment', enrollmentSchema);
