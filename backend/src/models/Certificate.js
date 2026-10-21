'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { baseOptions, lowercaseTrim } = require('./common');
const { CREDENTIALS, CERTIFICATE_STATUSES } = require('../lib/constants');
const { formatCents } = require('../lib/money');

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

    /**
     * What was awarded, copied from the course at issue time.
     *
     * Copied rather than read through the course for the same reason the names
     * are copied: a certificate is a historical document. If a course is later
     * upgraded from certificate to diploma, the certificates already issued must
     * keep saying what they said when they were issued.
     */
    credential: { type: String, enum: CREDENTIALS, default: 'certificate', index: true },

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

    /**
     * The rendered, printable certificate.
     *
     * `select: false` because a base64 PDF is by far the largest thing on this
     * document — it would ride along on every list and every verification
     * request, which never need it. Only the download endpoint opts in.
     *
     * Stored in the document rather than object storage because none is
     * configured on this deployment, and a certificate nobody can download is
     * not worth more than one that can.
     */
    pdfBase64: { type: String, select: false, default: null },
    pdfGeneratedAt: { type: Date, default: null },

    /** Revoked certificates stay resolvable but report as revoked. */
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, maxlength: 500, default: null },

    /**
     * Where the document is in its life.
     *
     * `pending_payment` means the course is finished and the number is reserved,
     * but the certificate is not issued and cannot be downloaded until the fee is
     * confirmed. Certificates created before this field existed have no stored
     * value and are read as `issued` — see `isIssued` — so nothing already earned
     * changes state.
     */
    status: { type: String, enum: CERTIFICATE_STATUSES, default: 'issued', index: true },

    /**
     * What the student owes for this certificate, fixed when it is created.
     *
     * Copied from the course rather than read from it later: an instructor who
     * raises the fee after a student has finished must not move that student's
     * price, and an order already paid at the old amount must still settle.
     */
    feeCents: { type: Number, default: 0, min: 0 },
    currency: { ...lowercaseTrim, default: 'usd' },
    paidAt: { type: Date, default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  },
  baseOptions
);

certificateSchema.index({ student: 1, issueDate: -1 });

/**
 * Whether the document has actually been awarded.
 *
 * A missing `status` is an old record that was issued before certificates could
 * be withheld for payment, so it counts as issued. Written as a method rather
 * than a comparison at each call site because two call sites would eventually
 * disagree about the missing-field case.
 */
certificateSchema.methods.isIssued = function isIssued() {
  return !this.revokedAt && (this.status || 'issued') === 'issued';
};

/** The public verification payload. Deliberately minimal: no email, no id. */
certificateSchema.methods.toVerificationJSON = function toVerificationJSON() {
  const status = this.status || 'issued';

  return {
    // A certificate waiting to be paid for has not been issued, so it does not
    // verify. Saying it is valid would let an employer accept a document the
    // academy has not actually awarded.
    valid: !this.revokedAt && status === 'issued',
    revoked: Boolean(this.revokedAt),
    status,
    revokedReason: this.revokeReason || null,
    certificateNumber: this.certificateNumber,
    verificationCode: this.verificationCode,
    studentName: this.studentName,
    courseTitle: this.courseTitle,
    instructorName: this.instructorName,
    // What was awarded. The verification page names it, because an employer
    // checking a candidate's "Wuteve Diploma" must see a diploma, not something
    // vaguer — a page that contradicted the student would make the student look
    // dishonest and the academy look broken.
    credential: this.credential || 'certificate',
    issueDate: this.issueDate,
    completionDate: this.completionDate,
    hoursCompleted: this.hoursCompleted,
    grade: this.grade,
    pdfUrl: this.pdfUrl,
    issuedBy: 'Wuteve Global Academy',
  };
};

certificateSchema.methods.toJSONForOwner = function toJSONForOwner(extra = {}) {
  const status = this.status || 'issued';

  return {
    ...this.toVerificationJSON(),
    id: String(this._id),
    courseId: String(this.course),
    verifyUrl: `/verify/${this.verificationCode}`,
    // What it costs to claim, and whether claiming is what is missing. The
    // student dashboard drives its "Pay $X to claim" button from these two
    // fields rather than inferring them from the status.
    feeCents: this.feeCents || 0,
    feeLabel: this.feeCents > 0 ? formatCents(this.feeCents, this.currency) : null,
    requiresPayment: status === 'pending_payment',
    paidAt: this.paidAt,
    ...extra,
  };
};

module.exports = mongoose.model('Certificate', certificateSchema);
