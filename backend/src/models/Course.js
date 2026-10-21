'use strict';

const mongoose = require('mongoose');

const { COURSE_LEVELS, COURSE_STATUSES, CREDENTIALS, CERTIFICATE_FEE_OPTIONS, COURSE_CATEGORIES } = require('../lib/constants');
const { baseOptions, lowercaseTrim } = require('./common');
const { formatCents, formatCentsOrFree } = require('../lib/money');
const { slugify } = require('../lib/slug');

/**
 * Category slug to its label, built once.
 *
 * The catalogue page maps labels in the browser because it fetches the taxonomy
 * anyway. The course page does not, so it printed the raw slug: "finance-accounting"
 * where every card around it said "Finance & Accounting".
 * Resolving here means one answer for every caller and no extra request.
 */
const CATEGORY_LABELS = Object.fromEntries(
  COURSE_CATEGORIES.map((category) => [category.slug, category.label])
);

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Course title is required'], trim: true, maxlength: 160 },
    slug: { ...lowercaseTrim, unique: true, index: true },

    summary: { type: String, trim: true, maxlength: 280, default: '' },
    description: { type: String, trim: true, maxlength: 20000, default: '' },

    thumbnail: { type: String, trim: true, default: null },

  /**
   * An uploaded cover image, if the instructor uploaded one rather than linking
   * to one.
   *
   * Kept in the database rather than written to `public/`: the app runs in a
   * container whose filesystem is discarded on every deploy, so a file saved to
   * disk would disappear and every cover would 404 after the next release.
   *
   * Both fields are `select: false` so the binary never travels with a course
   * list — `thumbnail` above holds the URL the pages actually render, and that is
   * the only thing they need.
   */
  thumbnailImage: { type: Buffer, select: false, default: null },
  thumbnailContentType: { type: String, select: false, default: null },
    promoVideoUrl: { type: String, trim: true, default: null },

    category: { ...lowercaseTrim, default: 'general', index: true },
    tags: { type: [String], default: [] },
    level: { type: String, enum: COURSE_LEVELS, default: 'beginner', index: true },

  /**
   * What completing this course awards.
   *
   * Defaults to `certificate` so every course that existed before this field
   * keeps issuing exactly what it issued before. `degree` is in the enum but
   * cannot be set: see SELECTABLE_CREDENTIALS in lib/constants.
   */
  credential: { type: String, enum: CREDENTIALS, default: 'certificate', index: true },
    language: { ...lowercaseTrim, default: 'english' },

    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    instructorName: { type: String, trim: true, default: '' },

    /**
     * Money as an integer number of minor units (cents). Storing 4999 for
     * $49.99 avoids the rounding drift that floats introduce, and is the unit
     * Stripe expects anyway. 0 means the course is free.
     */
    priceCents: { type: Number, default: 0, min: 0, max: 100000000 },
    currency: { ...lowercaseTrim, default: 'usd' },

    /**
     * An optional charge for the certificate, on a course that is otherwise free.
     *
     * A paid course already includes its certificate, so the fee is not applied
     * there. The stored value is NOT zeroed when a course becomes paid: an
     * instructor who sets $30 and then charges $50 for the course would lose
     * that decision, and would have to remember it if the course became free
     * again. `certificateFeeDueCents` below is the figure that actually applies,
     * and it is what every caller must read.
     */
    certificateFeeCents: { type: Number, enum: CERTIFICATE_FEE_OPTIONS, default: 0 },

    durationHours: { type: Number, default: 0, min: 0, max: 10000 },

    // Denormalised counters, maintained by the services that change them so
    // that catalog pages never need a fan-out aggregation on the hot path.
    lessonCount: { type: Number, default: 0, min: 0 },
    enrolledCount: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    ratingCount: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: COURSE_STATUSES, default: 'draft', index: true },
    publishedAt: { type: Date, default: null },

    // Set by an admin when a course is reviewed; kept for an audit trail.
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 500, default: null },

    /** Set while a soft delete is pending, so the group cannot drift apart. */
    archivedAt: { type: Date, default: null },
  },
  baseOptions
);

// Catalog queries: published courses filtered by category/level, newest first.
courseSchema.index({ status: 1, publishedAt: -1 });
courseSchema.index({ instructor: 1, status: 1, updatedAt: -1 });
courseSchema.index({ title: 'text', summary: 'text', description: 'text', tags: 'text' });

courseSchema.virtual('isFree').get(function isFree() {
  return this.priceCents === 0;
});

/**
 * The certificate fee that applies to a student finishing this course.
 *
 * Zero on a paid course: the certificate is part of what was bought. Reading the
 * raw `certificateFeeCents` instead of this is the mistake this virtual exists to
 * prevent — it would charge a student twice for one course.
 */
courseSchema.virtual('certificateFeeDueCents').get(function certificateFeeDueCents() {
  if (this.priceCents > 0) return 0;
  return this.certificateFeeCents || 0;
});

/** "$30.00" while a fee applies, null when the certificate is included. */
courseSchema.virtual('certificateFeeLabel').get(function certificateFeeLabel() {
  const due = this.certificateFeeDueCents;
  return due > 0 ? formatCents(due, this.currency) : null;
});

courseSchema.virtual('rating').get(function rating() {
  if (!this.ratingCount) return 0;
  return Math.round((this.ratingSum / this.ratingCount) * 10) / 10;
});

/** Human-readable price, e.g. "$49.99" — or "Free" when the course is free.
 *  Formatting lives on the server so the pages cannot disagree about how money
 *  is displayed, and it lives in `lib/money` so the server cannot disagree with
 *  itself either. */
courseSchema.virtual('priceLabel').get(function priceLabel() {
  return formatCentsOrFree(this.priceCents, this.currency);
});

courseSchema.pre('validate', function setSlug(next) {
  if (!this.slug && this.title) this.slug = slugify(this.title);
  next();
});

/** Card shape for catalog and dashboard listings. */
courseSchema.methods.toCardJSON = function toCardJSON(extra = {}) {
  return {
    id: String(this._id),
    title: this.title,
    slug: this.slug,
    summary: this.summary,
    thumbnail: this.thumbnail,
    category: this.category,
    // The label, so a page without the taxonomy still names the subject.
    categoryLabel: CATEGORY_LABELS[this.category] || this.category || null,
    level: this.level,
    credential: this.credential,
    tags: this.tags,
    instructorName: this.instructorName,
    priceCents: this.priceCents,
    currency: this.currency,
    priceLabel: this.priceLabel,
    isFree: this.isFree,
    certificateFeeCents: this.certificateFeeCents || 0,
    certificateFeeDueCents: this.certificateFeeDueCents,
    certificateFeeLabel: this.certificateFeeLabel,
    durationHours: this.durationHours,
    lessonCount: this.lessonCount,
    enrolledCount: this.enrolledCount,
    rating: this.rating,
    ratingCount: this.ratingCount,
    status: this.status,
    publishedAt: this.publishedAt,
    // Included so moderation screens can say when a course last changed. Without
    // them the admin table had nothing to show and every row read "—".
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    ...extra,
  };
};

courseSchema.methods.toDetailJSON = function toDetailJSON(extra = {}) {
  return {
    ...this.toCardJSON(),
    description: this.description,
    promoVideoUrl: this.promoVideoUrl,
    language: this.language,
    instructor: this.instructor && this.instructor.toAuthorJSON
      ? this.instructor.toAuthorJSON()
      : String(this.instructor),
    ...extra,
  };
};

module.exports = mongoose.model('Course', courseSchema);
