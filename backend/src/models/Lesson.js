'use strict';

const mongoose = require('mongoose');

const { LESSON_TYPES, VIDEO_KINDS, RESOURCE_KINDS } = require('../lib/constants');
const { baseOptions } = require('./common');

const resourceSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 200 },
    url: { type: String, trim: true, maxlength: 2000 },

    /** `link` is an external address; `file` lives in object storage. */
    kind: { type: String, enum: RESOURCE_KINDS, default: 'link' },
    /** Object key for a `file` resource. Never a URL — see the note on video. */
    fileKey: { type: String, trim: true, maxlength: 500, default: null },
    size: { type: Number, min: 0, default: 0 },
    mime: { type: String, trim: true, maxlength: 120, default: '' },
  },
  { _id: true }
);

/**
 * An uploaded video, described by its key rather than its address.
 *
 * Storing a permanent URL here would be the whole security model undone: the
 * bucket is private, and access is granted by a short-lived signed URL minted per
 * request for someone who is allowed to watch. A stored public URL would be
 * shareable by any enrolled student, permanently, to anyone.
 */
const videoFileSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 500 },
    size: { type: Number, min: 0, default: 0 },
    mime: { type: String, trim: true, maxlength: 120, default: '' },
    originalName: { type: String, trim: true, maxlength: 260, default: '' },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    title: { type: String, required: [true, 'Lesson title is required'], trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 400, default: '' },

    type: { type: String, enum: LESSON_TYPES, default: 'video' },

    /** Body for `text` lessons. Plain text / light markdown, rendered client side. */
    content: { type: String, trim: true, maxlength: 100000, default: '' },

    /**
     * Link mode. Kept exactly as it was: existing lessons store a YouTube or
     * Vimeo address here and must keep working untouched.
     */
    videoUrl: { type: String, trim: true, default: null },

    /** Which of the two video sources is live. `none` when the lesson has neither. */
    videoType: { type: String, enum: VIDEO_KINDS, default: 'none' },

    /** Upload mode. Populated once a file has landed in object storage. */
    videoFile: { type: videoFileSchema, default: null },

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
 * Which video source is actually playable.
 *
 * Derived rather than trusted, for two reasons. A lesson authored before
 * `videoType` existed has `videoUrl` set and the field defaulted to `none`, and
 * would otherwise silently stop playing. And the two sources must never both be
 * live, or the player has to guess which one the instructor meant.
 */
lessonSchema.methods.resolvedVideoType = function resolvedVideoType() {
  const hasFile = Boolean(this.videoFile && this.videoFile.key);
  const hasLink = Boolean(this.videoUrl);

  if (this.videoType === 'upload' && hasFile) return 'upload';
  if (this.videoType === 'link' && hasLink) return 'link';
  if (hasFile) return 'upload';
  if (hasLink) return 'link';
  return 'none';
};

/** Keep the stored field in step with the fields it describes. */
lessonSchema.pre('validate', function normaliseVideoType(next) {
  this.videoType = this.resolvedVideoType();
  next();
});

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
    // Which video source is live, so a list can show it without fetching bodies.
    videoType: this.resolvedVideoType(),
    ...extra,
  };
};

/** Full lesson, including body and media. Only sent to people allowed to read it. */
lessonSchema.methods.toFullJSON = function toFullJSON(extra = {}) {
  const resources = Array.isArray(this.resources) ? this.resources : [];
  const type = this.resolvedVideoType();
  const file = this.videoFile || {};

  /**
   * `playbackUrl` is not stored anywhere: the route mints a short-lived signed
   * URL for this one response. In link mode it is the stored address, which needs
   * no signing because the embed already lives on someone else's CDN.
   */
  const playbackUrl = type === 'upload' ? (extra.videoPlaybackUrl || null) : (type === 'link' ? this.videoUrl : null);

  return {
    ...this.toSummaryJSON(),
    content: this.content,

    // Kept so any existing consumer of this field keeps working unchanged.
    videoUrl: this.videoUrl,

    video: {
      type,
      url: type === 'link' ? this.videoUrl : null,
      playbackUrl,
      // Expiry of the signed URL, so the player can refresh before it lapses
      // rather than failing mid-lesson.
      playbackUrlExpiresAt: type === 'upload' ? (extra.videoPlaybackUrlExpiresAt || null) : null,
      mime: type === 'upload' ? file.mime || '' : '',
      sizeBytes: type === 'upload' ? file.size || 0 : 0,
      originalName: type === 'upload' ? file.originalName || '' : '',
      // The key itself is never sent to a client.
    },

    resources: resources.map((resource) => ({
      id: String(resource._id),
      title: resource.title,
      url: resource.url,
      kind: resource.kind || 'link',
      mime: resource.mime || '',
      sizeBytes: resource.size || 0,
    })),
    ...extra,
  };
};

module.exports = mongoose.model('Lesson', lessonSchema);
