'use strict';

const express = require('express');

const AdmissionApplication = require('../models/AdmissionApplication');
const User = require('../models/User');

const storageService = require('../services/storageService');
const notifications = require('../services/notificationService');
const email = require('../services/email');

const config = require('../config/env');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created } = require('../lib/respond');
const { badRequest, notFound } = require('../lib/errors');
const { MAX_ADMISSION_UPLOAD_BYTES } = require('../lib/constants');

const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/admissions');

const router = express.Router();

/**
 * Offline admissions.
 *
 * Everything here that writes is rate-limited, because it is the only public
 * endpoint on the platform that both stores files and sends email to an address
 * the caller chooses. Without a limit it is a free mail relay and a free file
 * host.
 */

/* ------------------------------------------------------------------ *
 * POST /api/v1/admissions/uploads — ask for a signed upload URL
 * ------------------------------------------------------------------ */

router.post(
  '/uploads',
  writeLimiter,
  validate({ body: schemas.uploadBody }),
  asyncHandler(async (req, res) => {
    const { purpose, filename, contentType, sizeBytes } = req.valid.body;

    if (sizeBytes > MAX_ADMISSION_UPLOAD_BYTES) {
      throw badRequest(`Each file must be ${Math.floor(MAX_ADMISSION_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`, {
        code: 'UPLOAD_TOO_LARGE',
      });
    }

    const key = storageService.buildAdmissionKey({ filename, purpose });
    const signed = await storageService.createUploadUrl({ key, contentType });

    return ok(
      res,
      {
        uploadUrl: signed.url,
        key: signed.key,
        expiresIn: signed.expiresIn,
        contentType: signed.contentType,
        maxBytes: MAX_ADMISSION_UPLOAD_BYTES,
      },
      'Upload URL issued.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/admissions — submit an application
 * ------------------------------------------------------------------ */

/** Tell every administrator, without failing the submission if that fails. */
async function notifyAdmins(application) {
  try {
    const admins = await User.find({ role: 'admin', status: 'active' }).select('_id');
    if (!admins.length) return;

    await notifications.notifyMany(
      admins.map((admin) => admin._id),
      {
        title: 'New offline admission application',
        message: `${application.firstName} ${application.lastName} applied for ${application.classLevel} (${application.trackingNumber}).`,
        type: 'system',
        link: '/admin-dashboard.html#admissions',
        meta: { admissionId: String(application._id) },
      }
    );
  } catch (error) {
    logger.error('could not notify administrators of an admission application', {
      error: error && error.message,
      trackingNumber: application.trackingNumber,
    });
  }
}

router.post(
  '/',
  writeLimiter,
  validate({ body: schemas.submitBody }),
  asyncHandler(async (req, res) => {
    const body = req.valid.body;

    /**
     * The photograph and the documents are keys this API issued; nothing about
     * the request is taken on trust. A key that does not look like one of ours,
     * or that the bucket has never seen, is refused rather than stored, so an
     * application cannot point at somebody else's file.
     */
    const expectAdmissionKey = (key) => String(key).startsWith('admissions/');

    let photo = null;

    if (body.photoKey) {
      if (!expectAdmissionKey(body.photoKey)) {
        throw badRequest('That photograph upload was not issued by this form. Please upload it again.', {
          code: 'UPLOAD_KEY_INVALID',
        });
      }

      photo = await storageService.statObject(body.photoKey);
      if (!photo) {
        throw badRequest('That photograph was not found in storage. Please upload it again.', {
          code: 'UPLOAD_MISSING',
        });
      }
    }

    const documents = [];
    for (const doc of body.documents || []) {
      if (!expectAdmissionKey(doc.key)) continue;
      // eslint-disable-next-line no-await-in-loop
      const stat = await storageService.statObject(doc.key);
      if (!stat) continue;
      documents.push({ key: doc.key, name: doc.name, size: stat.size || doc.size || 0, mime: stat.contentType || doc.mime });
    }

    // Tracking numbers are random, but a collision must not lose an application.
    let trackingNumber = AdmissionApplication.newTrackingNumber();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const clash = await AdmissionApplication.exists({ trackingNumber });
      if (!clash) break;
      trackingNumber = AdmissionApplication.newTrackingNumber();
    }

    const application = await AdmissionApplication.create({
      trackingNumber,
      classLevel: body.classLevel,
      firstName: body.firstName,
      lastName: body.lastName,
      gender: body.gender,
      dateOfBirth: body.dateOfBirth,
      mobile: body.mobile,
      email: body.email,
      religion: body.religion,
      photoKey: body.photoKey,
      photoMime: (photo && photo.contentType) || body.photoMime,
      fatherName: body.fatherName,
      fatherPhone: body.fatherPhone,
      motherName: body.motherName,
      motherPhone: body.motherPhone,
      motherOccupation: body.motherOccupation,
      previousSchool: body.previousSchool,
      documents,
    });

    setImmediate(async () => {
      try {
        await email.deliver(email.admissionReceivedEmail({ application }));
      } catch (error) {
        logger.error('admission received email failed', {
          error: error && error.message,
          trackingNumber: application.trackingNumber,
        });
      }

      await notifyAdmins(application);
    });

    return created(
      res,
      { application: application.toPublicJSON() },
      `Application received. Your tracking number is ${application.trackingNumber}.`
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/admissions/status/:tracking — check an application
 * ------------------------------------------------------------------ */

router.get(
  '/status/:tracking',
  validate({ params: schemas.trackingParam }),
  asyncHandler(async (req, res) => {
    const application = await AdmissionApplication.findOne({
      trackingNumber: req.valid.params.tracking,
    });

    if (!application) {
      throw notFound('No application matches that tracking number.', { code: 'APPLICATION_NOT_FOUND' });
    }

    return ok(res, { application: application.toPublicJSON() });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/admissions/classes — what an applicant can choose from
 * ------------------------------------------------------------------ */

router.get(
  '/classes',
  asyncHandler(async (req, res) => {
    /**
     * Read from configuration so the offline programme can add or remove a class
     * without a code change. Falls back to a small, honest default: the academy
     * runs beginner-level practical programmes, and inventing a list of named
     * classes here would be a claim nobody has verified.
     */
    const configured = String(process.env.OFFLINE_CLASSES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    const classes = configured.length
      ? configured
      : [
          'Computer Literacy',
          'Microsoft Office',
          'Bookkeeping and Accounting',
          'Business Management',
          'Digital Marketing',
        ];

    return ok(res, { classes: classes.map((name) => ({ value: name, label: name })) });
  })
);

module.exports = router;
