'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * A student's review of a course.
 *
 * Reviews are moderated before they appear. `pending` and `rejected` reviews are
 * never counted in a course's rating, and never shown to anyone except their
 * author and an administrator — an unmoderated queue would let the first
 * submission set the public score of a course.
 *
 * The author's name is denormalised because the catalogue and the course page
 * read reviews in one query and must not populate a user per row. It is
 * refreshed when the reviewer edits their review and when their profile changes.
 */
const reviewSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    studentName: { type: String, trim: true, default: '' },
    studentAvatar: { type: String, trim: true, default: null },

    rating: {
      type: Number,
      required: [true, 'Choose a rating'],
      min: [1, 'Choose a rating between 1 and 5'],
      max: [5, 'Choose a rating between 1 and 5'],
      validate: {
        validator: Number.isInteger,
        message: 'A rating must be a whole number of stars',
      },
    },

    title: { type: String, trim: true, maxlength: 120, default: '' },
    body: { type: String, required: [true, 'Write your review'], trim: true, maxlength: 4000 },

    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },

    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    moderatedAt: { type: Date, default: null },
    moderationNote: { type: String, trim: true, maxlength: 500, default: null },
  },
  baseOptions
);

/** One review per student per course: editing replaces, it does not add. */
reviewSchema.index({ course: 1, student: 1 }, { unique: true });

/** The course page lists approved reviews newest first. */
reviewSchema.index({ course: 1, status: 1, createdAt: -1 });

/** The moderation queue lists pending reviews oldest first. */
reviewSchema.index({ status: 1, createdAt: 1 });

reviewSchema.methods.toJSONForViewer = function toJSONForViewer(viewerId, extra = {}) {
  const viewer = viewerId ? String(viewerId) : null;
  const isMine = viewer ? String(this.student) === viewer : false;
  const visible = this.status === 'approved' || isMine;

  return {
    id: String(this._id),
    courseId: String(this.course),
    rating: this.rating,
    title: visible ? this.title : '',
    body: visible ? this.body : '',
    status: this.status,
    author: {
      id: String(this.student),
      name: this.studentName || 'A student',
      avatarUrl: this.studentAvatar || null,
    },
    isMine,
    // Only the author is told why a review was refused.
    moderationNote: isMine && this.status === 'rejected' ? this.moderationNote : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    ...extra,
  };
};

module.exports = mongoose.model('Review', reviewSchema);
