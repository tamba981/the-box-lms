'use strict';

const mongoose = require('mongoose');

const { LESSON_TYPES } = require('../lib/constants');
const { baseOptions } = require('./common');

const resourceSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 200 },
    url: { type: String, trim: true, maxlength: 2000 },
  },
  { _id: true }
);

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    title: { type: String, required: [true, 'Lesson title is required'], trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 400, default: '' },

    type: { type: String, enum: LESSON_TYPES, default: 'video' },

    /** Body for `text` lessons. Plain text / light markdown, rendered client side. */
    content: { type: String, trim: true, maxlength: 100000, default: '' },
    videoUrl: { type: String, trim: true, default: null },

    /** 1-based position within the course. Unique per course. */
    order: { type: Number, required: true, min: 1 },

    durationMinutes: { type: Number, default: 0, min: 0, max: 100000 },
    resources: { type: [resourceSchema], default: [] },

    /** Preview lessons are readable without enrolling — the course sales pitch. */
    isPreview: { type: Boolean, default: false },

    published: { type: Boolean, default: true },
  },
  baseOptions
);

// The one ordering the app relies on. Enforced here rather than in each query.
lessonSchema.index({ course: 1, order: 1 }, { unique: true });
lessonSchema.index({ course: 1, published: 1 });

/**
 * Lesson summary for lists — no body or video URL, so a course outline cannot
 * be scraped by an unenrolled visitor.
 */
lessonSchema.methods.toSummaryJSON = function toSummaryJSON(extra = {}) {
  return {
    id: String(this._id),
    course: String(this.course),
    title: this.title,
    summary: this.summary,
    type: this.type,
    order: this.order,
    durationMinutes: this.durationMinutes,
    isPreview: this.isPreview,
    // Guarded: a query that projects a subset of fields leaves an unselected
    // array path undefined, and reading `.length` off it would throw.
    resourceCount: Array.isArray(this.resources) ? this.resources.length : 0,
    ...extra,
  };
};

/** Full lesson, including body and media. Only sent to people allowed to read it. */
lessonSchema.methods.toFullJSON = function toFullJSON(extra = {}) {
  const resources = Array.isArray(this.resources) ? this.resources : [];

  return {
    ...this.toSummaryJSON(),
    content: this.content,
    videoUrl: this.videoUrl,
    resources: resources.map((resource) => ({
      id: String(resource._id),
      title: resource.title,
      url: resource.url,
    })),
    ...extra,
  };
};

module.exports = mongoose.model('Lesson', lessonSchema);
