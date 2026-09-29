'use strict';

/**
 * Shared domain vocabulary. Kept in one place so the API, the models and the
 * pages cannot drift apart on spelling or casing.
 */

const ROLES = Object.freeze(['student', 'instructor', 'admin']);

const COURSE_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);

const COURSE_STATUSES = Object.freeze(['draft', 'pending', 'published', 'archived']);

const ENROLLMENT_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);

const LESSON_TYPES = Object.freeze(['video', 'text', 'quiz', 'live']);

const NOTIFICATION_TYPES = Object.freeze([
  'announcement',
  'assignment',
  'live',
  'message',
  'certificate',
  'payment',
  'system',
]);

const LIVE_SESSION_STATUSES = Object.freeze(['scheduled', 'live', 'ended', 'cancelled']);

const PAYMENT_STATUSES = Object.freeze(['pending', 'paid', 'failed', 'refunded']);

const TOKEN_TYPES = Object.freeze(['refresh', 'reset', 'verify']);

const THREAD_TYPES = Object.freeze(['direct', 'group', 'instructor', 'course']);

/** Progress at or above this percentage is treated as course completion. */
const COMPLETION_THRESHOLD = 100;

module.exports = {
  ROLES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  ENROLLMENT_STATUSES,
  LESSON_TYPES,
  NOTIFICATION_TYPES,
  LIVE_SESSION_STATUSES,
  PAYMENT_STATUSES,
  TOKEN_TYPES,
  THREAD_TYPES,
  COMPLETION_THRESHOLD,
};
