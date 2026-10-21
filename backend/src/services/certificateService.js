'use strict';

const Certificate = require('../models/Certificate');
const Counter = require('../models/Counter');
const QuizAttempt = require('../models/QuizAttempt');
const { renderCertificate, buildVerificationUrl } = require('./certificateRenderer');
const logger = require('../lib/logger');

/**
 * Certificate issuing.
 *
 * Issuing is idempotent by design. A student who re-opens the last lesson of a
 * completed course, or two concurrent requests that both finish it, must not
 * produce two certificates — the enrollment's unique (student, course) index
 * means there is only ever one enrollment, and this function checks it first
 * and again after the insert, so a race resolves to a single document.
 */

/** WGA-2026-000123 */
async function nextCertificateNumber(date = new Date()) {
  const year = date.getFullYear();
  const sequence = await Counter.next(`certificate-${year}`);

  return `WGA-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * A course grade, from the quizzes the student actually sat.
 *
 * The best score on each quiz, averaged over the course's quizzes — a second
 * attempt should help, not be averaged in as a penalty.
 *
 * Returns null when the course has no quizzes the student has attempted. A course
 * with no assessment has no grade, and printing "0%" on a certificate would be a
 * claim about the student that nothing supports.
 */
async function quizGradeFor(studentId, courseId) {
  const attempts = await QuizAttempt.find({ student: studentId, course: courseId }).select(
    'quiz scorePercent'
  );

  if (!attempts.length) return null;

  const best = new Map();
  for (const attempt of attempts) {
    const key = String(attempt.quiz);
    best.set(key, Math.max(best.get(key) || 0, attempt.scorePercent));
  }

  const scores = [...best.values()];
  const average = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);

  return `${average}%`;
}

/**
 * Re-derive an already-issued certificate's grade.
 *
 * A student can finish every lesson and be issued a certificate before sitting the
 * last quiz, which would leave it permanently ungraded. Called after an attempt,
 * it keeps the document describing the student's actual result.
 */
async function refreshGrade(studentId, courseId) {
  const certificate = await Certificate.findOne({ student: studentId, course: courseId, revokedAt: null });
  if (!certificate) return null;

  const grade = await quizGradeFor(studentId, courseId);
  if (grade && grade !== certificate.grade) {
    certificate.grade = grade;
    await certificate.save();
    logger.info('certificate grade updated', { certificateNumber: certificate.certificateNumber, grade });
  }

  return certificate;
}

/**
 * @param {import('mongoose').Document} enrollment
 * @param {import('mongoose').Document} course
 * @param {import('mongoose').Document} student
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function issueFor(enrollment, course, student) {
  // Already issued — hand back the existing document rather than making another.
  if (enrollment.certificate) {
    const existing = await Certificate.findById(enrollment.certificate);
    if (existing) return existing;
  }

  const previous = await Certificate.findOne({ student: student._id, course: course._id, revokedAt: null });
  if (previous) {
    // Repair the link if it was lost, then return what already exists.
    if (!enrollment.certificate) {
      enrollment.certificate = previous._id;
      await enrollment.save();
    }
    return previous;
  }

  try {
    /**
     * What the certificate costs, fixed now.
     *
     * Read through `certificateFeeDueCents`, which is zero on a paid course —
     * buying the course already includes its certificate. Copying the figure
     * onto the document locks the price at the moment of completion, so an
     * instructor changing it later cannot move it under a student who has
     * already finished.
     */
    const feeCents = typeof course.certificateFeeDueCents === 'number' ? course.certificateFeeDueCents : 0;

    const certificate = await Certificate.create({
      student: student._id,
      course: course._id,
      enrollment: enrollment._id,
      studentName: student.fullName,
      courseTitle: course.title,
      instructorName: course.instructorName || '',
      // Copied now rather than joined later: an issued certificate records what
      // was awarded on the day, so changing the course cannot rewrite it.
      credential: course.credential || 'certificate',
      certificateNumber: await nextCertificateNumber(),
      completionDate: enrollment.completedAt || new Date(),
      hoursCompleted: enrollment.hoursSpent || 0,
      // A fee means the document exists but is not awarded yet: the number is
      // reserved, the PDF is not rendered, and the download endpoint refuses it.
      status: feeCents > 0 ? 'pending_payment' : 'issued',
      feeCents,
      currency: course.currency || 'usd',
      // Null when the course has no quizzes; the certificate simply shows none.
      grade: await quizGradeFor(student._id, course._id),
    });

    enrollment.certificate = certificate._id;
    await enrollment.save();

    /**
     * The printable document.
     *
     * It is generated here, as part of issuing, but it is never allowed to fail
     * the issuance: a student who finished the course has earned the credential
     * whatever happens to the renderer, and a certificate record without its
     * PDF can be re-rendered later. A 500 in the completion handler would take
     * the enrolment down with it.
     *
     * Skipped entirely while the certificate is waiting to be paid for: a
     * document that exists is a document somebody will find a way to download,
     * and the point of withholding it is that it is not awarded yet.
     */
    if (certificate.status !== 'pending_payment') await attachRenderedPdf(certificate);

    logger.info('certificate issued', {
      certificateNumber: certificate.certificateNumber,
      studentId: String(student._id),
      courseId: String(course._id),
      status: certificate.status,
      feeCents,
    });

    return certificate;
  } catch (error) {
    // Unique index collision means a concurrent request won. Use its document.
    if (error && error.code === 11000) {
      const raced = await Certificate.findOne({ student: student._id, course: course._id });
      if (raced) {
        enrollment.certificate = raced._id;
        await enrollment.save();
        return raced;
      }
    }
    throw error;
  }
}

async function revoke(certificateId, reason) {
  return Certificate.findByIdAndUpdate(
    certificateId,
    {
      $set: {
        revokedAt: new Date(),
        revokeReason: reason || 'Revoked by an administrator',
        // Kept in step with `revokedAt`, which stays the field the rest of the
        // system reads. Writing only one of the two would leave a document that
        // is revoked by one measure and issued by the other.
        status: 'revoked',
      },
    },
    { new: true }
  );
}

/**
 * Award a certificate whose fee has been confirmed.
 *
 * Called from `settlePayment`, never from a route: a certificate becomes
 * `issued` in exactly one place, the same place every other payment becomes
 * something real.
 *
 * Idempotent. A repeated confirmation finds the certificate already issued and
 * returns it rather than re-rendering or re-dating it.
 */
async function markPaid(certificate, payment = null) {
  if (!certificate) return null;
  // Already awarded. A second confirmation must not re-date or re-render it.
  if (certificate.status === 'issued') return certificate;

  const now = new Date();

  certificate.status = 'issued';
  certificate.paidAt = certificate.paidAt || now;
  // The date printed on the document is the date it was awarded, which is now —
  // not the date the student finished, which is already recorded separately as
  // `completionDate`.
  certificate.issueDate = now;
  if (payment) certificate.payment = payment._id;
  await certificate.save();

  await attachRenderedPdf(certificate);

  logger.info('certificate issued after payment', {
    certificateNumber: certificate.certificateNumber,
    paymentId: payment ? String(payment._id) : null,
  });

  return certificate;
}

/**
 * Render the PDF for a certificate and store it on the document.
 *
 * Deliberately swallowing every error: see the call site.
 */
async function attachRenderedPdf(certificate) {
  try {
    const { buffer } = await renderCertificate({
      studentName: certificate.studentName,
      courseName: certificate.courseTitle,
      certificateNumber: certificate.certificateNumber,
      credentialType: certificate.credential || 'certificate',
      issuedAt: certificate.issueDate,
      // The QR points at the same pretty URL the emails use, so a scanned code
      // and an emailed link arrive at the same place.
      verificationUrl: buildVerificationUrl(certificate.verificationCode),
    });

    const base64 = buffer.toString('base64');

    await Certificate.updateOne(
      { _id: certificate._id },
      { $set: { pdfBase64: base64, pdfGeneratedAt: new Date() } }
    );

    /**
     * Kept on the in-memory document as well as in the database.
     *
     * `pdfBase64` is `select: false`, so the certificate the caller is holding
     * would otherwise look like it has no document — and the email that is built
     * moments later in the same request would go out without its attachment.
     */
    certificate.pdfBase64 = base64;
    certificate.pdfGeneratedAt = new Date();

    return true;
  } catch (error) {
    logger.error('certificate PDF render failed', {
      certificateNumber: certificate.certificateNumber,
      error,
    });
    return false;
  }
}

module.exports = {
  attachRenderedPdf, issueFor, revoke, markPaid, nextCertificateNumber, quizGradeFor, refreshGrade };
