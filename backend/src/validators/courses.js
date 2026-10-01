'use strict';

const { z } = require('zod');

const { COURSE_LEVELS, COURSE_STATUSES, LESSON_TYPES } = require('./auth').enums;
const { objectId, paginationQuery, optionalUrl } = require('./auth');

/**
 * Course and lesson input schemas.
 *
 * `priceCents` is an integer number of minor units. The client never sends a
 * float for money, and never sends `price: "49.99"`.
 */

const slugOrId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'Invalid course reference');

const courseIdParam = z.object({ courseId: objectId });
const lessonIdParam = z.object({ courseId: objectId, lessonId: objectId });

const priceCents = z.coerce
  .number({ invalid_type_error: 'Price must be a number' })
  .int('Price must be a whole number of cents')
  .min(0, 'Price cannot be negative')
  .max(100000000, 'Price is too large');

const courseFields = {
  title: z.string().trim().min(4, 'Title must be at least 4 characters').max(160, 'Title is too long'),
  summary: z.string().trim().max(280, 'Summary is too long').optional(),
  description: z.string().trim().max(20000, 'Description is too long').optional(),
  thumbnail: optionalUrl.optional(),
  promoVideoUrl: optionalUrl.optional(),
  category: z.string().trim().min(2, 'Category is required').max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(15, 'Too many tags').optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  language: z.string().trim().min(2).max(40).optional(),
  priceCents: priceCents.optional(),
  currency: z.string().trim().length(3, 'Use a 3-letter currency code').toLowerCase().optional(),
  durationHours: z.coerce.number().min(0).max(10000).optional(),
};

const createCourseBody = z.object({
  title: courseFields.title,
  summary: courseFields.summary,
  description: courseFields.description,
  thumbnail: courseFields.thumbnail,
  promoVideoUrl: courseFields.promoVideoUrl,
  category: courseFields.category,
  tags: courseFields.tags,
  level: courseFields.level,
  language: courseFields.language,
  priceCents: courseFields.priceCents,
  currency: courseFields.currency,
  durationHours: courseFields.durationHours,
});

const updateCourseBody = z
  .object({
    title: courseFields.title.optional(),
    summary: courseFields.summary,
    description: courseFields.description,
    thumbnail: courseFields.thumbnail,
    promoVideoUrl: courseFields.promoVideoUrl,
    category: courseFields.category,
    tags: courseFields.tags,
    level: courseFields.level,
    language: courseFields.language,
    priceCents: courseFields.priceCents,
    currency: courseFields.currency,
    durationHours: courseFields.durationHours,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const listCoursesQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  price: z.enum(['free', 'paid']).optional(),
  instructor: objectId.optional(),
  sort: z.enum(['newest', 'popular', 'rating', 'price_asc', 'price_desc', 'title']).optional().default('newest'),
  page: paginationQuery.shape.page,
  limit: paginationQuery.shape.limit,
});

const myCoursesQuery = z.object({
  status: z.enum(COURSE_STATUSES).optional(),
  page: paginationQuery.shape.page,
  limit: paginationQuery.shape.limit,
});

const lessonFields = {
  title: z.string().trim().min(2, 'Lesson title is required').max(200, 'Lesson title is too long'),
  summary: z.string().trim().max(400, 'Summary is too long').optional(),
  type: z.enum(LESSON_TYPES).optional(),
  content: z.string().trim().max(100000, 'Lesson body is too long').optional(),
  videoUrl: optionalUrl.optional(),
  order: z.coerce.number().int().min(1).max(10000).optional(),
  durationMinutes: z.coerce.number().min(0).max(100000).optional(),
  isPreview: z.coerce.boolean().optional(),
  published: z.coerce.boolean().optional(),
  resources: z
    .array(z.object({ title: z.string().trim().min(1).max(200), url: z.string().trim().url('Resource URL is invalid').max(2000) }))
    .max(30, 'Too many resources')
    .optional(),
};

const createLessonBody = z.object({
  title: lessonFields.title,
  summary: lessonFields.summary,
  type: lessonFields.type,
  content: lessonFields.content,
  videoUrl: lessonFields.videoUrl,
  order: lessonFields.order,
  durationMinutes: lessonFields.durationMinutes,
  isPreview: lessonFields.isPreview,
  resources: lessonFields.resources,
});

const updateLessonBody = z
  .object({
    title: lessonFields.title.optional(),
    summary: lessonFields.summary,
    type: lessonFields.type,
    content: lessonFields.content,
    videoUrl: lessonFields.videoUrl,
    order: lessonFields.order,
    durationMinutes: lessonFields.durationMinutes,
    isPreview: lessonFields.isPreview,
    published: lessonFields.published,
    resources: lessonFields.resources,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const reorderLessonsBody = z.object({
  lessonIds: z.array(objectId).min(1, 'Provide the lesson order').max(500),
});

/**
 * An uploaded cover image, sent as a data URL.
 *
 * There is no multipart parser on this deployment — no `multer`, and no route to
 * the npm registry from the machine this runs on — so the image travels
 * base64-encoded inside JSON instead. Express already caps a JSON body at 1 MB,
 * and the cap below sits deliberately inside that, so an oversized image is
 * refused with a readable message rather than an opaque 413.
 *
 * The route re-checks the decoded length and the magic bytes. The `image/...`
 * prefix in a data URL is supplied by the client and is not evidence of anything.
 */
const thumbnailUploadBody = z.object({
  image: z
    .string()
    .trim()
    .regex(
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
      'Upload a PNG, JPEG or WebP image'
    )
    .max(900000, 'That image is too large — please use one under about 600 KB'),
});

module.exports = {
  slugOrId,
  courseIdParam,
  lessonIdParam,
  createCourseBody,
  updateCourseBody,
  listCoursesQuery,
  myCoursesQuery,
  createLessonBody,
  updateLessonBody,
  reorderLessonsBody,
    thumbnailUploadBody,  };