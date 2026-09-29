'use strict';

const Notification = require('../models/Notification');

const email = require('./email');
const logger = require('../lib/logger');

/**
 * Notifications.
 *
 * Every notification is a database row (so the bell in the dashboard has a real
 * list), and optionally an email. Email is best effort and never awaited by the
 * caller's critical path.
 */

const TYPES = {
  ANNOUNCEMENT: 'announcement',
  ASSIGNMENT: 'assignment',
  LIVE: 'live',
  MESSAGE: 'message',
  CERTIFICATE: 'certificate',
  PAYMENT: 'payment',
  SYSTEM: 'system',
};

async function notify(userId, { title, message, type = TYPES.SYSTEM, link = null, meta = {}, email: sendEmail }) {
  const notification = await Notification.notify(userId, { title, message, type, link, meta });

  if (sendEmail) {
    setImmediate(async () => {
      try {
        await email.deliver(sendEmail);
      } catch (error) {
        logger.error('notification email failed', { error });
      }
    });
  }

  return notification;
}

async function notifyMany(userIds, payload) {
  return Notification.notifyMany(userIds, payload);
}

const onEnrollment = (userId, course, link) =>
  notify(userId, {
    title: `Welcome to ${course.title}`,
    message: 'Your enrollment is confirmed. Start with the first lesson whenever you are ready.',
    type: TYPES.ANNOUNCEMENT,
    link,
    meta: { courseId: String(course._id) },
  });

const onCertificate = (userId, certificate, link) =>
  notify(userId, {
    title: 'Your certificate is ready',
    message: `You completed "${certificate.courseTitle}". Certificate ${certificate.certificateNumber} has been issued.`,
    type: TYPES.CERTIFICATE,
    link,
    meta: { certificateId: String(certificate._id), certificateNumber: certificate.certificateNumber },
  });

const onLiveSession = (userIds, session, link) =>
  notifyMany(userIds, {
    title: `Live session: ${session.title}`,
    message: `${session.courseTitle} · ${new Date(session.startTime).toUTCString()}`,
    type: TYPES.LIVE,
    link,
    meta: { sessionId: String(session._id), courseId: String(session.course) },
  });

const onMessage = (userId, senderName, preview, link) =>
  notify(userId, {
    title: `New message from ${senderName}`,
    message: preview.slice(0, 160),
    type: TYPES.MESSAGE,
    link,
  });

const onCoursePublished = (userId, course, link) =>
  notify(userId, {
    title: 'Your course is live',
    message: `"${course.title}" has been approved and is now visible in the catalog.`,
    type: TYPES.ANNOUNCEMENT,
    link,
    meta: { courseId: String(course._id) },
  });

const onCourseSubmitted = (userIds, course, link) =>
  notifyMany(userIds, {
    title: 'Course awaiting review',
    message: `"${course.title}" was submitted for publication.`,
    type: TYPES.ANNOUNCEMENT,
    link,
    meta: { courseId: String(course._id) },
  });

const onPayment = (userId, payment, course, link) =>
  notify(userId, {
    title: 'Payment received',
    message: `Your payment for "${course.title}" is confirmed and your enrollment is active.`,
    type: TYPES.PAYMENT,
    link,
    meta: { paymentId: String(payment._id), courseId: String(course._id) },
  });

module.exports = {
  TYPES,
  notify,
  notifyMany,
  onEnrollment,
  onCertificate,
  onLiveSession,
  onMessage,
  onCoursePublished,
  onCourseSubmitted,
  onPayment,
};
