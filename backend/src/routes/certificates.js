'use strict';

const express = require('express');

const Certificate = require('../models/Certificate');
const Enrollment = require('../models/Enrollment');
const certificateService = require('../services/certificateService');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { notFound, paymentRequired, unavailable } = require('../lib/errors');
const { formatCents } = require('../lib/money');
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

/* ------------------------------------------------------------------ *
 * GET /api/v1/certificates/:id/download — the printable PDF
 * ------------------------------------------------------------------ */

router.get(
  '/:id/download',
  authenticate,
  validate({ params: z.object({ id: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid certificate reference') }) }),
  asyncHandler(async (req, res) => {
    const certificate = await Certificate.findById(req.valid.params.id).select('+pdfBase64');

    if (!certificate) {
      throw notFound('That certificate could not be found.', { code: 'CERTIFICATE_NOT_FOUND' });
    }

    // A certificate belongs to the person named on it. Anything else — including
    // telling a stranger that it exists — is refused the same way as a missing
    // record.
    const isOwner = String(certificate.student) === String(req.user._id);
    if (!isOwner && req.user.role !== 'admin') {
      throw notFound('That certificate could not be found.', { code: 'CERTIFICATE_NOT_FOUND' });
    }

    /**
     * A certificate that still has to be paid for has not been issued.
     *
     * 402 rather than 403: the record is this student's, they are allowed to know
     * it exists, and what is missing is a payment — not permission. Nothing is
     * rendered on this path either, so the document cannot be produced by asking
     * for it early.
     */
    if (certificate.status === 'pending_payment') {
      throw paymentRequired(
        `This certificate has not been issued yet. Pay ${formatCents(
          certificate.feeCents || 0,
          certificate.currency
        )} to claim it from your dashboard.`,
        { code: 'CERTIFICATE_PAYMENT_REQUIRED' }
      );
    }

    if (!certificate.pdfBase64) {
      // Older certificates were issued before the renderer existed. Rendering
      // on demand means they are not permanently stuck without a document.
      const rendered = await certificateService.attachRenderedPdf(certificate);
      if (!rendered) {
        throw unavailable('This certificate could not be prepared for download. Please try again shortly.', {
          code: 'CERTIFICATE_RENDER_FAILED',
        });
      }
      certificate.pdfBase64 = (
        await Certificate.findById(certificate._id).select('+pdfBase64')
      ).pdfBase64;
    }

    const fileName = buildFileName(certificate);
    const bytes = Buffer.from(certificate.pdfBase64, 'base64');

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
    res.set('Content-Length', String(bytes.length));
    // Private: the document is personal, and a shared cache must not hold it.
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('X-Content-Type-Options', 'nosniff');

    return res.send(bytes);
  })
);

/**
 * A filename a person can find in their downloads folder later.
 *
 * The course title is the only part that is not already filename-safe, so it is
 * reduced to ASCII words; quotes and slashes would break the header itself.
 */
function buildFileName(certificate) {
  const slug = (value) =>
    String(value || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'certificate';

  return [
    slug(certificate.studentName),
    slug(certificate.courseTitle),
    certificate.credential || 'certificate',
  ].join('-') + '.pdf';
}

module.exports = router;
