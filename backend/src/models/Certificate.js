'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * A certificate issued on course completion.
 *
 * Two separate identifiers, on purpose:
 *   - `certificateNumber` is the human-readable serial printed on the document
 *     (WGA-2026-000123).
 *   - `verificationCode` is a long random string used by the public
 *     /verify/:code page. It is unguessable, so certificates cannot be
 *     enumerated by incrementing a serial number.
 */
const certificateSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    enrollment: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', default: null },

    // Copy of the names as they were at issue time. A certificate is a
    // historical document: renaming a course must not rewrite issued records.
    studentName: { type: String, required: true, trim: true },
    courseTitle: { type: String, required: true, trim: true },
    instructorName: { type: String, trim: true, default: '' },

    certificateNumber: { type: String, required: true, unique: true, index: true },
    verificationCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => crypto.randomBytes(20).toString('base64url'),
    },

    issueDate: { type: Date, default: Date.now },
    completionDate: { type: Date, default: null },
    hoursCompleted: { type: Number, default: 0, min: 0 },
    grade: { type: String, trim: true, default: null },

    pdfUrl: { type: String, trim: true, default: null },

    /** Revoked certificates stay resolvable but report as revoked. */
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, maxlength: 500, default: null },
  },
  baseOptions
);

certificateSchema.index({ student: 1, issueDate: -1 });

/** The public verification payload. Deliberately minimal: no email, no id. */
certificateSchema.methods.toVerificationJSON = function toVerificationJSON() {
  return {
    valid: !this.revokedAt,
    revoked: Boolean(this.revokedAt),
    revokedReason: this.revokeReason || null,
    certificateNumber: this.certificateNumber,
    verificationCode: this.verificationCode,
    studentName: this.studentName,
    courseTitle: this.courseTitle,
    instructorName: this.instructorName,
    issueDate: this.issueDate,
    completionDate: this.completionDate,
    hoursCompleted: this.hoursCompleted,
    grade: this.grade,
    pdfUrl: this.pdfUrl,
    issuedBy: 'Wuteve Global Academy',
  };
};

certificateSchema.methods.toJSONForOwner = function toJSONForOwner(extra = {}) {
  return {
    ...this.toVerificationJSON(),
    id: String(this._id),
    courseId: String(this.course),
    verifyUrl: `/verify/${this.verificationCode}`,
    ...extra,
  };
};

module.exports = mongoose.model('Certificate', certificateSchema);
