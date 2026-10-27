'use strict';

/**
 * Shared domain vocabulary. Kept in one place so the API, the models and the
 * pages cannot drift apart on spelling or casing.
 */

const ROLES = Object.freeze(['student', 'instructor', 'admin']);

/**
 * Account lifecycle.
 *
 * `pending` and `rejected` exist for instructor applications: a self-registered
 * instructor is not usable until an administrator has looked at the application,
 * so "exists but cannot sign in yet" has to be a status of its own. Students
 * never reach either value - `POST /auth/register` hard-codes `student` and
 * `active`.
 */
const USER_STATUSES = Object.freeze(['active', 'suspended', 'pending', 'rejected']);

const COURSE_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);

const COURSE_STATUSES = Object.freeze(['draft', 'pending', 'published', 'archived']);

/**
 * Subject categories a course can be filed under.
 *
 * Slugs, with the label alongside. `business-management` is stable in a URL,
 * in an index and in an old bookmark; "Business & Management" is not. Keeping
 * both here means the API, the instructor picker and the catalog filter read
 * the same list — which they did not before: the instructor form hard-coded
 * three options and so could not offer `data` or `productivity`, the two
 * categories four of the seeded courses were already using.
 */
const COURSE_CATEGORIES = Object.freeze([
  { slug: 'technology', label: 'Technology' },
  { slug: 'business-management', label: 'Business & Management' },
  { slug: 'data-analytics', label: 'Data & Analytics' },
  { slug: 'design', label: 'Design' },
  { slug: 'health-care', label: 'Health & Care' },
  { slug: 'education', label: 'Education' },
  { slug: 'agriculture', label: 'Agriculture' },
  { slug: 'trades-vocational', label: 'Trades & Vocational' },
  { slug: 'finance-accounting', label: 'Finance & Accounting' },
  { slug: 'language', label: 'Language' },
  { slug: 'professional-development', label: 'Professional Development' },
  { slug: 'digital-skills', label: 'Digital Skills' },
]);

const COURSE_CATEGORY_SLUGS = Object.freeze(COURSE_CATEGORIES.map((category) => category.slug));

/**
 * Categories that predate the list above, and where they now belong.
 *
 * Anything arriving with an old value is translated rather than refused, so an
 * existing bookmark like `?category=business` keeps returning the same courses.
 */
const LEGACY_CATEGORY_ALIASES = Object.freeze({
  business: 'business-management',
  data: 'data-analytics',
  productivity: 'digital-skills',
});

/**
 * What completing a course awards.
 *
 * `degree` is defined and deliberately unselectable. The academy cannot issue
 * one until it has a partner institution or its own accreditation, so it lives
 * in the enum — future code and existing data have a value to use — and stays
 * out of SELECTABLE_CREDENTIALS, which is what the validator reads. Nothing can
 * set it through any request.
 */
const CREDENTIALS = Object.freeze(['certificate', 'diploma', 'degree']);
const SELECTABLE_CREDENTIALS = Object.freeze(['certificate', 'diploma']);

const CREDENTIAL_LABELS = Object.freeze({
  certificate: 'Certificate of Completion',
  diploma: 'Diploma',
  degree: 'Degree',
});

const ENROLLMENT_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);

/**
 * What kind of lesson this is. Descriptive, not structural.
 *
 * The body, the video and the materials are separate fields that any lesson may
 * have; `type` is the label a student sees and filters by. `pdf` and `mixed` were
 * added later and need no migration: older lessons keep the value they were
 * saved with, and nothing in the API reads `type` to decide what to send.
 */
const LESSON_TYPES = Object.freeze(['video', 'text', 'pdf', 'mixed', 'live']);

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
 * What a lesson material may be.
 *
 * Every one of these renders or downloads safely from a signed URL. HTML and SVG
 * are deliberately absent: both can carry script, and a bucket that serves them
 * inline turns a worksheet into stored XSS on this origin.
 */
const ALLOWED_MATERIAL_MIME = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'application/zip',
]);

/** Extensions matching ALLOWED_MATERIAL_MIME, used when building object keys. */
const ALLOWED_MATERIAL_EXTENSIONS = Object.freeze([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'txt',
  'csv',
  'zip',
]);

/** 25 MB. A worksheet is not a video; anything larger is the wrong file. */
const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;

/**
 * Images accepted for an admission photo or a scanned document.
 *
 * SVG is excluded for the same reason it is excluded from materials.
 */
const ALLOWED_IMAGE_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** 5 MB per admission upload. */
const MAX_ADMISSION_UPLOAD_BYTES = 5 * 1024 * 1024;

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

/**
 * A payment's lifecycle.
 *
 * `awaiting_verification` is the manual flow's middle state: the student has said
 * they sent the money and nobody has confirmed it yet. It is kept apart from
 * `pending` because the two are waiting on different people — `pending` waits on
 * the student to pay, `awaiting_verification` waits on the academy to check.
 *
 * A manual order that is confirmed ends at `paid`, rather than at a `verified`
 * status of its own, so that the revenue report — which sums `status: 'paid'` —
 * counts money that arrived offline without having to know how it arrived.
 */
const PAYMENT_STATUSES = Object.freeze([
  'pending',
  'awaiting_verification',
  'paid',
  'failed',
  'rejected',
  'expired',
  'refunded',
]);

const TOKEN_TYPES = Object.freeze(['refresh', 'reset', 'verify']);

/**
 * What a certificate is waiting for.
 *
 * `pending_payment` is the only state that is not a finished document: the
 * student has completed the course and the record exists with its number
 * reserved, but the certificate has not been issued and cannot be downloaded.
 * Records created before this field existed have no value stored, so every
 * read treats a missing status as `issued` — see `isIssued` on the model.
 */
const CERTIFICATE_STATUSES = Object.freeze(['pending_payment', 'issued', 'revoked']);

/**
 * What a payment bought.
 *
 * Two products, one payment table, because both are the same act — a person
 * sends money and a member of staff confirms it arrived. Splitting them into
 * two collections would mean two settlement paths, and two settlement paths
 * eventually disagree about idempotency.
 */
const PAYMENT_PURPOSES = Object.freeze(['enrollment', 'certificate']);

/**
 * The certificate fees an instructor may choose, in minor units.
 *
 * A fixed list rather than any integer: these are round dollar amounts, they
 * are what the mobile-money instructions tell a student to send, and a free
 * text price invites four different spellings of "ten dollars".
 */
const CERTIFICATE_FEE_OPTIONS = Object.freeze([0, 1000, 2000, 3000, 4000, 5000]);

const THREAD_TYPES = Object.freeze(['direct', 'group', 'instructor', 'course']);

/** Progress at or above this percentage is treated as course completion. */
const COMPLETION_THRESHOLD = 100;

/**
 * Why somebody is writing to the academy. Stored as the key; the contact form
 * shows the label.
 */
const CONTACT_REASONS = Object.freeze(['general', 'partnership', 'support', 'other']);

module.exports = {
  ROLES,
  USER_STATUSES,
  CONTACT_REASONS,
  COURSE_LEVELS,
  COURSE_STATUSES,
  COURSE_CATEGORIES,
  COURSE_CATEGORY_SLUGS,
  LEGACY_CATEGORY_ALIASES,
  CREDENTIALS,
  SELECTABLE_CREDENTIALS,
  CREDENTIAL_LABELS,
  ENROLLMENT_STATUSES,
  LESSON_TYPES,
  VIDEO_KINDS,
  ALLOWED_VIDEO_MIME,
  ALLOWED_VIDEO_EXTENSIONS,
  MAX_VIDEO_BYTES,
  RESOURCE_KINDS,
  ALLOWED_MATERIAL_MIME,
  ALLOWED_MATERIAL_EXTENSIONS,
  MAX_MATERIAL_BYTES,
  ALLOWED_IMAGE_MIME,
  MAX_ADMISSION_UPLOAD_BYTES,
  EMBEDDABLE_VIDEO_HOSTS,
  NOTIFICATION_TYPES,
  LIVE_SESSION_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_PURPOSES,
  CERTIFICATE_STATUSES,
  CERTIFICATE_FEE_OPTIONS,
  TOKEN_TYPES,
  THREAD_TYPES,
  COMPLETION_THRESHOLD,
};
