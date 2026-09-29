'use strict';

const express = require('express');

const Certificate = require('../models/Certificate');
const Enrollment = require('../models/Enrollment');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { notFound } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { paginationQuery } = require('../validators/auth');
const { z } = require('zod');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * GET /api/v1/certificates/me
 * ------------------------------------------------------------------ */

router.get(
  '/me',
  authenticate,
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const [certificates, total] = await Promise.all([
      Certificate.find({ student: req.user._id }).sort({ issueDate: -1 }).skip(skip).limit(limit),
      Certificate.countDocuments({ student: req.user._id }),
    ]);

    return ok(
      res,
      paginated(
        certificates.map((certificate) => certificate.toJSONForOwner()),
        total,
        { page, limit }
      )
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/certificates/verify/:code — public verification
 * ------------------------------------------------------------------ */

/**
 * Deliberately unauthenticated: the entire point of a verifiable certificate is
 * that a third party — an employer, an admissions office — can confirm it
 * without an account. The payload exposes only what is printed on the document
 * itself: a name, a course title and a date. No email, no account id, no
 * address.
 */
router.get(
  '/verify/:code',
  validate({ params: z.object({ code: z.string().trim().min(8).max(120) }) }),
  asyncHandler(async (req, res) => {
    const { code } = req.valid.params;

    // Accept either the printed serial (WGA-2026-000123) or the random
    // verification code, so a person can type in whichever they can see.
    const certificate = await Certificate.findOne({
      $or: [{ verificationCode: code }, { certificateNumber: code.toUpperCase() }],
    });

    if (!certificate) {
      return ok(res, { valid: false, found: false, message: 'No certificate matches that reference.' });
    }

    return ok(res, { found: true, ...certificate.toVerificationJSON() });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/certificates/:id — owner (or admin) only
 * ------------------------------------------------------------------ */

router.get(
  '/:id',
  authenticate,
  validate({ params: z.object({ id: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid certificate reference') }) }),
  asyncHandler(async (req, res) => {
    const certificate = await Certificate.findById(req.valid.params.id);
    if (!certificate) throw notFound('That certificate could not be found.', { code: 'CERTIFICATE_NOT_FOUND' });

    const isOwner = String(certificate.student) === String(req.user._id);
    if (!isOwner && req.user.role !== 'admin') {
      throw notFound('That certificate could not be found.', { code: 'CERTIFICATE_NOT_FOUND' });
    }

    const enrollment = await Enrollment.findOne({
      student: certificate.student,
      course: certificate.course,
    });

    return ok(res, {
      certificate: certificate.toJSONForOwner({
        enrollmentId: enrollment ? String(enrollment._id) : null,
        progress: enrollment ? enrollment.progress : null,
      }),
    });
  })
);

module.exports = router;
