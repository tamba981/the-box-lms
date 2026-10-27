'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * An application for an offline (in-person) course.
 *
 * This is deliberately separate from `User`. Most applicants are not learners on
 * the platform yet, and an application must be recordable without creating an
 * account somebody could sign in with — an unapproved applicant with a login is
 * exactly the gap the instructor flow already closes by keeping applicants
 * `pending` until an administrator decides.
 *
 * Photographs and supporting documents live in object storage, and only their
 * keys are stored here. The bucket is private, so a key is useless without a
 * signed URL minted for an administrator.
 */

/** Crockford-style alphabet: no I, O, 0 or 1, so a code can be read aloud. */
const TRACKING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function newTrackingNumber() {
  let body = '';
  for (let i = 0; i < 8; i += 1) {
    body += TRACKING_ALPHABET[crypto.randomInt(TRACKING_ALPHABET.length)];
  }
  return `WGA-ADM-${body}`;
}

const admissionApplicationSchema = new mongoose.Schema(
  {
    trackingNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    /** Which offline class the applicant is applying for. */
    classLevel: { type: String, required: true, trim: true, maxlength: 120 },

    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    gender: { type: String, enum: ['female', 'male', 'other', 'prefer_not_to_say'], required: true },
    dateOfBirth: { type: Date, required: true },
    mobile: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160, index: true },
    religion: { type: String, trim: true, maxlength: 80, default: '' },

    /** Object key for the passport photograph. Never a URL. */
    photoKey: { type: String, trim: true, maxlength: 500, default: null },
    photoMime: { type: String, trim: true, maxlength: 120, default: '' },

    fatherName: { type: String, trim: true, maxlength: 120, default: '' },
    fatherPhone: { type: String, trim: true, maxlength: 40, default: '' },
    motherName: { type: String, trim: true, maxlength: 120, default: '' },
    motherPhone: { type: String, trim: true, maxlength: 40, default: '' },
    motherOccupation: { type: String, trim: true, maxlength: 120, default: '' },

    previousSchool: { type: String, trim: true, maxlength: 300, default: '' },

    /** Supporting documents: keys, with the original name for the admin view. */
    documents: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true, trim: true, maxlength: 500 },
            name: { type: String, trim: true, maxlength: 260, default: '' },
            size: { type: Number, min: 0, default: 0 },
            mime: { type: String, trim: true, maxlength: 120, default: '' },
          },
          { _id: true }
        ),
      ],
      default: [],
    },

    /** Set when an administrator decides. Kept as an audit trail. */
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },

    /** When the applicant was told the outcome. */
    notifiedAt: { type: Date, default: null },
  },
  baseOptions
);

admissionApplicationSchema.index({ status: 1, createdAt: -1 });
admissionApplicationSchema.index({ email: 1, createdAt: -1 });

/**
 * A public shape, for the applicant checking their own status.
 *
 * Deliberately narrow: it confirms the application exists, what it is for and
 * where it stands, and nothing about the household, the documents or the
 * reviewer. A tracking number is a bearer token — anyone holding it can read
 * this — so it must not disclose more than "we have it".
 */
admissionApplicationSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    trackingNumber: this.trackingNumber,
    status: this.status,
    classLevel: this.classLevel,
    firstName: this.firstName,
    lastName: this.lastName,
    submittedAt: this.createdAt,
    decidedAt: this.reviewedAt,
    note: this.status === 'rejected' ? this.decisionNote : null,
  };
};

/** Everything an administrator needs, including signed document links. */
admissionApplicationSchema.methods.toAdminJSON = function toAdminJSON(extra = {}) {
  return {
    id: String(this._id),
    trackingNumber: this.trackingNumber,
    status: this.status,
    classLevel: this.classLevel,
    firstName: this.firstName,
    lastName: this.lastName,
    fullName: `${this.firstName} ${this.lastName}`.trim(),
    gender: this.gender,
    dateOfBirth: this.dateOfBirth,
    mobile: this.mobile,
    email: this.email,
    religion: this.religion,
    photoKey: this.photoKey,
    fatherName: this.fatherName,
    fatherPhone: this.fatherPhone,
    motherName: this.motherName,
    motherPhone: this.motherPhone,
    motherOccupation: this.motherOccupation,
    previousSchool: this.previousSchool,
    documents: (this.documents || []).map((doc) => ({
      id: String(doc._id),
      name: doc.name,
      size: doc.size,
      mime: doc.mime,
    })),
    reviewedAt: this.reviewedAt,
    decisionNote: this.decisionNote,
    createdAt: this.createdAt,
    ...extra,
  };
};

const AdmissionApplication = mongoose.model('AdmissionApplication', admissionApplicationSchema);

AdmissionApplication.newTrackingNumber = newTrackingNumber;

module.exports = AdmissionApplication;
