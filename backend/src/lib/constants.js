'use strict';

/**
 * Shared domain vocabulary. Kept in one place so the API, the models and the
 * pages cannot drift apart on spelling or casing.
 */

const ROLES = Object.freeze(['student', 'instructor', 'admin']);

const COURSE_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);

const COURSE_STATUSES = Object.freeze(['draft', 'pending', 'published', 'archived']);

const ENROLLMENT_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);

const LESSON_TYPES = Object.freeze(['video', 'text', 'live']);

/**
 * How a lesson's video is supplied. `link` is a YouTube/Vimeo URL the instructor
 * pastes; `upload` is a file they sent to object storage. `none` means the lesson
 * has no video (a text lesson, or one not authored yet).
 *
 * Only one is ever live at a time, so the two can never disagree about what to play.
 */
const VIDEO_KINDS = Object.freeze(['none', 'link', 'upload']);

/**
 * Container formats a browser can actually play back in an element.
 *
 * MOV is deliberately absent. iPhones record HEVC/H.265 by default, which Chrome
 * and Firefox cannot decode, so accepting MOV would produce uploads that look
 * successful and then will not play. Instructors export MP4 instead. Without a
 * transcoder there is no way to convert it for them.
 */
const ALLOWED_VIDEO_MIME = Object.freeze([
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

/** File extensions permitted to go with those types, used when building keys. */
const ALLOWED_VIDEO_EXTENSIONS = Object.freeze(['mp4', 'webm', 'ogv', 'ogg']);

/** 500 MB. Enforced before a signed URL is issued and again after upload. */
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** Attachments on a lesson are either an external link or an uploaded file. */
const RESOURCE_KINDS = Object.freeze(['link', 'file']);

/**
 * Hosts a lesson video may be embedded from.
 *
 * This is a security boundary, not a convenience. The address is rendered into an
 * iframe, so an open allowlist would let an instructor frame any third-party page
 * inside this site — which can be used for clickjacking or to impersonate the
 * academy. The player rebuilds the embed from the parsed video id and never puts
 * the raw stored address into a src attribute.
 */
const EMBEDDABLE_VIDEO_HOSTS = Object.freeze([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'player.vimeo.com',
]);

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
  VIDEO_KINDS,
  ALLOWED_VIDEO_MIME,
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_VIDEO_BYTES,
  RESOURCE_KINDS,
  EMBEDDABLE_VIDEO_HOSTS,
  NOTIFICATION_TYPES,
  LIVE_SESSION_STATUSES,
  PAYMENT_STATUSES,
  TOKEN_TYPES,
  THREAD_TYPES,
  COMPLETION_THRESHOLD,
};
