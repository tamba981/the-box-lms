'use strict';

const Certificate = require('../models/Certificate');
const Counter = require('../models/Counter');
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
    const certificate = await Certificate.create({
      student: student._id,
      course: course._id,
      enrollment: enrollment._id,
      studentName: student.fullName,
      courseTitle: course.title,
      instructorName: course.instructorName || '',
      certificateNumber: await nextCertificateNumber(),
      completionDate: enrollment.completedAt || new Date(),
      hoursCompleted: enrollment.hoursSpent || 0,
    });

    enrollment.certificate = certificate._id;
    await enrollment.save();

    logger.info('certificate issued', {
      certificateNumber: certificate.certificateNumber,
      studentId: String(student._id),
      courseId: String(course._id),
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
    { $set: { revokedAt: new Date(), revokeReason: reason || 'Revoked by an administrator' } },
    { new: true }
  );
}

module.exports = { issueFor, revoke, nextCertificateNumber };
