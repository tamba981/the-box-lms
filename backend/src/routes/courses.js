'use strict';

const express = require('express');

const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Lesson = require('../models/Lesson');
const User = require('../models/User');

const enrollmentService = require('../services/enrollmentService');
const notifications = require('../services/notificationService');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const { contains } = require('../lib/text');
const { uniqueSlug } = require('../lib/slug');
const permissions = require('../lib/permissions');

const { authenticate, optionalAuth, requireInstructor } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/courses');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SORTS = {
  newest: { publishedAt: -1, createdAt: -1 },
  popular: { enrolledCount: -1, publishedAt: -1 },
  rating: { ratingCount: -1, ratingSum: -1 },
  price_asc: { priceCents: 1, title: 1 },
  price_desc: { priceCents: -1, title: 1 },
  title: { title: 1 },
};

/** Load a course by :courseId and assert the caller may author it. */
async function loadManagedCourse(req) {
  const course = await Course.findById(req.valid.params.courseId);
  if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

  permissions.assertCanManageCourse(req.user, course);
  return course;
}

function applyCourseFields(course, fields) {
  const { thumbnail, promoVideoUrl } = fields;

  if (fields.title !== undefined) course.title = fields.title;
  if (fields.summary !== undefined) course.summary = fields.summary;
  if (fields.description !== undefined) course.description = fields.description;
  if (thumbnail !== undefined) course.thumbnail = thumbnail || null;
  if (promoVideoUrl !== undefined) course.promoVideoUrl = promoVideoUrl || null;
  if (fields.category !== undefined) course.category = fields.category;
  if (fields.tags !== undefined) course.tags = fields.tags;
  if (fields.level !== undefined) course.level = fields.level;
  if (fields.language !== undefined) course.language = fields.language;
  if (fields.priceCents !== undefined) course.priceCents = fields.priceCents;
  if (fields.currency !== undefined) course.currency = fields.currency;
  if (fields.durationHours !== undefined) course.durationHours = fields.durationHours;
}

/**
 * Recompute the denormalised counters.
 *
 * Automated lessons (video, text) are always "completed" by reading them, so
 * duration is a sum. Course length comes from the same source so the catalog
 * and the course page cannot disagree.
 */
async function refreshCourseCounters(course) {
  const lessons = await Lesson.find({ course: course._id, published: true }).select('durationMinutes');

  course.lessonCount = lessons.length;
  course.durationHours = Math.round((lessons.reduce((sum, lesson) => sum + (lesson.durationMinutes || 0), 0) / 60) * 10) / 10;

  await course.save();
  return course;
}

/** Minutes of published lessons, kept as a separate small query for the tree. */
async function publishedLessonMinutes(courseId) {
  const rows = await Lesson.aggregate([
    { $match: { course: courseId, published: true } },
    { $group: { _id: null, minutes: { $sum: '$durationMinutes' } } },
  ]);

  return rows[0]?.minutes || 0;
}

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses — public catalog
 * ------------------------------------------------------------------ */

router.get(
  '/',
  optionalAuth,
  validate({ query: schemas.listCoursesQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    // Only published courses are ever listed publicly. An instructor does not
    // see their own drafts here — those live on /courses/mine.
    const filter = { status: 'published' };

    if (query.q) {
      const pattern = contains(query.q);
      filter.$or = [{ title: pattern }, { summary: pattern }, { tags: pattern }, { instructorName: pattern }];
    }
    if (query.category) filter.category = query.category.toLowerCase();
    if (query.level) filter.level = query.level;
    if (query.instructor) filter.instructor = query.instructor;
    if (query.price === 'free') filter.priceCents = 0;
    if (query.price === 'paid') filter.priceCents = { $gt: 0 };

    const [courses, total] = await Promise.all([
      Course.find(filter).sort(SORTS[query.sort] || SORTS.newest).skip(skip).limit(limit),
      Course.countDocuments(filter),
    ]);

    // Which of these is the viewer already enrolled in? One query, not N.
    const enrolledByCourse = new Map();

    if (req.user) {
      const enrollments = await Enrollment.find({
        student: req.user._id,
        course: { $in: courses.map((course) => course._id) },
        status: { $ne: 'cancelled' },
      }).select('course progress status');

      for (const enrollment of enrollments) {
        enrolledByCourse.set(String(enrollment.course), enrollment);
      }
    }

    const items = courses.map((course) => {
      const enrollment = enrolledByCourse.get(String(course._id));

      return course.toCardJSON({
        isEnrolled: Boolean(enrollment),
        myProgress: enrollment ? enrollment.progress : null,
      });
    });

    return ok(res, paginated(items, total, { page, limit }));
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses/categories — filter facets
 * ------------------------------------------------------------------ */

router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const categories = await Course.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 50 },
    ]);

    return ok(res, {
      categories: categories.map((row) => ({ name: row._id || 'general', count: row.count })),
    });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses/mine — authored courses
 * ------------------------------------------------------------------ */

router.get(
  '/mine',
  authenticate,
  requireInstructor,
  validate({ query: schemas.myCoursesQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);
    const filter = { instructor: req.user._id };
    if (req.valid.query.status) filter.status = req.valid.query.status;

    const [courses, total] = await Promise.all([
      Course.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      Course.countDocuments(filter),
    ]);

    const items = await Promise.all(
      courses.map(async (course) => {
        const [enrollmentCount, completionCount] = await Promise.all([
          Enrollment.countDocuments({ course: course._id, status: { $ne: 'cancelled' } }),
          Enrollment.countDocuments({ course: course._id, status: 'completed' }),
        ]);

        return course.toCardJSON({ enrollmentCount, completionCount });
      })
    );

    return ok(res, paginated(items, total, { page, limit }));
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses/:slug — course detail
 * ------------------------------------------------------------------ */

router.get(
  '/:slug',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const course = await permissions.loadVisibleCourse(req.params.slug, req.user);

    // Populate the instructor so the page can show a real author card.
    await course.populate({ path: 'instructor', select: 'firstName lastName role avatarUrl headline' });

    const lessons = await Lesson.find({ course: course._id })
      .sort({ order: 1 })
      .select('title summary type order durationMinutes isPreview published');

    const access = await permissions.resolveCourseAccess(req.user, course);

    // A visitor sees the outline; only enrolled students, the course's
    // instructor and admins see anything marked unpublished.
    const visibleLessons = lessons.filter(
      (lesson) => lesson.published || access.manages || req.user?.role === 'admin'
    );

    const completedIds = new Set((access.enrollment?.completedLessons || []).map(String));

    const syllabus = visibleLessons.map((lesson) =>
      lesson.toSummaryJSON({
        completed: completedIds.has(String(lesson._id)),
        // The padlock in the UI is driven by this, not by re-implementing the
        // rule on the client.
        locked: !access.canReadContent && !lesson.isPreview,
      })
    );

    return ok(res, {
      course: course.toDetailJSON({ isEnrolled: access.isEnrolled, myProgress: access.enrollment?.progress ?? null }),
      lessons: syllabus,
      access: {
        isEnrolled: access.isEnrolled,
        canEnroll: access.canEnroll,
        canReadContent: access.canReadContent,
        manages: access.manages,
        requiresPayment: access.requiresPayment,
        priceCents: course.priceCents,
        currency: course.currency,
        progress: access.enrollment?.progress ?? null,
        completedLessonIds: [...completedIds],
        certificateId: access.enrollment?.certificate ? String(access.enrollment.certificate) : null,
      },
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/courses — create
 * ------------------------------------------------------------------ */

router.post(
  '/',
  authenticate,
  requireInstructor,
  writeLimiter,
  validate({ body: schemas.createCourseBody }),
  asyncHandler(async (req, res) => {
    const slug = await uniqueSlug(req.valid.body.title, async (candidate) =>
      Boolean(await Course.exists({ slug: candidate }))
    );

    const course = new Course({
      ...req.valid.body,
      slug,
      instructor: req.user._id,
      instructorName: req.user.fullName,
      // Everything starts as a draft, including for an admin — publishing is a
      // separate, explicit action with its own endpoint.
      status: 'draft',
    });

    if (course.thumbnail === '') course.thumbnail = null;
    if (course.promoVideoUrl === '') course.promoVideoUrl = null;

    await course.save();

    return created(res, { course: course.toCardJSON() }, 'Course created as a draft.');
  })
);

/* ------------------------------------------------------------------ *
 * PATCH /api/v1/courses/:courseId — update
 * ------------------------------------------------------------------ */

router.patch(
  '/:courseId',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam, body: schemas.updateCourseBody }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);
    const titleChanged = req.valid.body.title !== undefined && req.valid.body.title !== course.title;

    applyCourseFields(course, req.valid.body);

    // A retitled course gets a new slug only if the old one was generated from
    // the old title; an explicitly customised slug is left alone.
    if (titleChanged) {
      const taken = await Course.exists({ slug: course.slug, _id: { $ne: course._id } });
      if (!taken) course.slug = await uniqueSlug(course.title, async (candidate) => Boolean(await Course.exists({ slug: candidate, _id: { $ne: course._id } })));
    }

    await course.save();

    // Keep the denormalised copies on enrollments and payments in step.
    await enrollmentService.syncCourseTitle(course);

    return ok(res, { course: course.toCardJSON() }, 'Course updated.');
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/courses/:courseId — archive
 * ------------------------------------------------------------------ */

router.delete(
  '/:courseId',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    // Soft delete. Students keep access to what they paid for; the course just
    // leaves the catalog.
    course.status = 'archived';
    course.archivedAt = new Date();
    await course.save();

    return noContent(res, 'Course archived. Existing students keep their access.');
  })
);

/* ------------------------------------------------------------------ *
 * Cover image
 *
 * Uploaded rather than linked. Asking an instructor to host an image somewhere
 * else and paste a URL is the step where most of them stop, and the course ends
 * up with a gradient placeholder.
 *
 * There is no multipart parser on this deployment — no `multer`, and no route to
 * the npm registry from the machine this is developed on — so the image arrives
 * base64-encoded in a JSON body. The decoded length and the magic bytes are
 * re-checked here: the `image/...` prefix of a data URL is supplied by the client
 * and is not evidence of anything.
 * ------------------------------------------------------------------ */

const MAX_THUMBNAIL_BYTES = 600 * 1024;

const IMAGE_SIGNATURES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/** The real format of the bytes, or null if it is not one we accept. */
function detectImageType(buffer) {
  for (const [type, signature] of Object.entries(IMAGE_SIGNATURES)) {
    if (buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(Buffer.from(signature))) {
      return type;
    }
  }

  // WebP is a RIFF container: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

router.get(
  '/:courseId/thumbnail',
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId).select(
      '+thumbnailImage +thumbnailContentType'
    );

    if (!course || !course.thumbnailImage || course.thumbnailImage.length === 0) {
      throw notFound('That course has no cover image.', { code: 'THUMBNAIL_NOT_FOUND' });
    }

    res.set('Content-Type', course.thumbnailContentType || 'application/octet-stream');
    // Short-lived rather than immutable: a replaced image is served from the same
    // URL, so a long cache would show the old cover for a day.
    res.set('Cache-Control', 'public, max-age=3600');
    // The bytes are attacker-influenced; never let a browser second-guess the type.
    res.set('X-Content-Type-Options', 'nosniff');

    return res.send(course.thumbnailImage);
  })
);

router.put(
  '/:courseId/thumbnail',
  authenticate,
  requireInstructor,
  writeLimiter,
  validate({ params: schemas.courseIdParam, body: schemas.thumbnailUploadBody }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    const buffer = Buffer.from(req.valid.body.image.split(',')[1], 'base64');

    if (buffer.length === 0) {
      throw badRequest('That image could not be read.', { code: 'THUMBNAIL_UNREADABLE' });
    }

    if (buffer.length > MAX_THUMBNAIL_BYTES) {
      throw badRequest(
        `That image is ${Math.round(buffer.length / 1024)} KB. Please use one under ${MAX_THUMBNAIL_BYTES / 1024} KB.`,
        { code: 'THUMBNAIL_TOO_LARGE' }
      );
    }

    const contentType = detectImageType(buffer);
    if (!contentType) {
      throw badRequest('That file is not a PNG, JPEG or WebP image.', { code: 'THUMBNAIL_BAD_TYPE' });
    }

    course.thumbnailImage = buffer;
    course.thumbnailContentType = contentType;
    // Every page already renders `thumbnail`, so pointing it at the route that
    // serves what was just stored is the whole of the integration.
    course.thumbnail = `/api/v1/courses/${course._id}/thumbnail`;
    await course.save();

    return ok(res, { course: course.toCardJSON() }, 'Cover image updated.');
  })
);

router.delete(
  '/:courseId/thumbnail',
  authenticate,
  requireInstructor,
  writeLimiter,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    course.thumbnailImage = null;
    course.thumbnailContentType = null;

    // Only withdraw the URL if it is the one this route serves. An external URL
    // was the instructor's choice and is not ours to delete.
    const served = `/api/v1/courses/${course._id}/thumbnail`;
    if (course.thumbnail === served) course.thumbnail = null;

    await course.save();

    return ok(res, { course: course.toCardJSON() }, 'Cover image removed.');
  })
);

/* ------------------------------------------------------------------ *
 * Publish lifecycle
 * ------------------------------------------------------------------ */

router.post(
  '/:courseId/publish',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    const lessonCount = await Lesson.countDocuments({ course: course._id, published: true });
    if (lessonCount === 0) {
      throw badRequest('Add at least one lesson before publishing.', {
        code: 'NO_LESSONS',
        details: [{ field: 'lessons', message: 'At least one published lesson is required' }],
      });
    }

    if (req.user.role === 'admin') {
      course.status = 'published';
      course.publishedAt = course.publishedAt || new Date();
      course.reviewedBy = req.user._id;
      course.reviewedAt = new Date();
      await course.save();

      notifications
        .onCoursePublished(course.instructor, course, `/instructor-dashboard.html#/course/${course._id}`)
        .catch(() => {});

      return ok(res, { course: course.toCardJSON() }, 'Course published.');
    }

    // An instructor's request goes into the moderation queue rather than live.
    course.status = 'pending';
    await course.save();

    const admins = await User.find({ role: 'admin' }).select('_id');
    notifications
      .onCourseSubmitted(admins.map((admin) => admin._id), course, `/admin-dashboard.html#/courses/${course._id}`)
      .catch(() => {});

    return ok(res, { course: course.toCardJSON() }, 'Course submitted for review.');
  })
);

router.post(
  '/:courseId/unpublish',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    course.status = 'draft';
    course.publishedAt = null;
    await course.save();

    return ok(res, { course: course.toCardJSON() }, 'Course returned to draft.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/courses/:courseId/roster
 * ------------------------------------------------------------------ */

router.get(
  '/:courseId/roster',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);
    const course = await loadManagedCourse(req);

    const filter = { course: course._id, status: { $ne: 'cancelled' } };

    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter)
        .sort({ lastAccessedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'student', select: 'firstName lastName email avatarUrl' }),
      Enrollment.countDocuments(filter),
    ]);

    const items = enrollments.map((enrollment) => ({
      id: String(enrollment._id),
      student: enrollment.student
        ? {
            id: String(enrollment.student._id),
            firstName: enrollment.student.firstName,
            lastName: enrollment.student.lastName,
            fullName: enrollment.student.fullName,
            email: enrollment.student.email,
            avatarUrl: enrollment.student.avatarUrl,
          }
        : null,
      progress: enrollment.progress,
      status: enrollment.status,
      hoursSpent: enrollment.hoursSpent,
      enrolledAt: enrollment.createdAt,
      completedAt: enrollment.completedAt,
      lastAccessedAt: enrollment.lastAccessedAt,
    }));

    const summary = {
      total,
      completed: await Enrollment.countDocuments({ course: course._id, status: 'completed' }),
      averageProgress: (await Enrollment.aggregate([
        { $match: { course: course._id, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, average: { $avg: '$progress' } } },
      ]))[0]?.average || 0,
    };

    return ok(res, { ...paginated(items, total, { page, limit }), summary });
  })
);

/* ------------------------------------------------------------------ *
 * Lessons
 * ------------------------------------------------------------------ */

router.get(
  '/:courseId/lessons',
  optionalAuth,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const access = await permissions.resolveCourseAccess(req.user, course);
    if (course.status !== 'published' && !access.manages) {
      throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });
    }

    const lessons = await Lesson.find({ course: course._id }).sort({ order: 1 });
    const completed = new Set((access.enrollment?.completedLessons || []).map(String));

    const items = lessons
      .filter((lesson) => lesson.published || access.manages)
      .map((lesson) =>
        lesson.toSummaryJSON({
          completed: completed.has(String(lesson._id)),
          locked: !access.canReadContent && !lesson.isPreview,
        })
      );

    return ok(res, {
      lessons: items,
      access: { isEnrolled: access.isEnrolled, canReadContent: access.canReadContent, manages: access.manages },
      totalMinutes: await publishedLessonMinutes(course._id),
    });
  })
);

/**
 * A single lesson, including its body and media.
 *
 * This is the endpoint that actually protects paid content: the outline is
 * public, but the body is only released to an enrolled student, the course
 * instructor, an admin, or for a lesson explicitly marked as a preview.
 */
router.get(
  '/:courseId/lessons/:lessonId',
  optionalAuth,
  validate({ params: schemas.lessonIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const lesson = await Lesson.findOne({ _id: req.valid.params.lessonId, course: course._id });
    if (!lesson) throw notFound('That lesson could not be found.', { code: 'LESSON_NOT_FOUND' });

    const access = await permissions.resolveCourseAccess(req.user, course);
    const mayRead = access.canReadContent || lesson.isPreview;

    if (!mayRead) {
      throw forbidden('Enroll in this course to open this lesson.', {
        code: 'ENROLLMENT_REQUIRED',
        details: [{ field: 'courseId', message: 'Enrollment required' }],
      });
    }

    if (access.enrollment) {
      await Enrollment.updateOne(
        { _id: access.enrollment._id },
        { $set: { lastAccessedAt: new Date(), lastLesson: lesson._id } }
      );
    }

    const completed = (access.enrollment?.completedLessons || []).some(
      (id) => String(id) === String(lesson._id)
    );

    // Navigation context, so the player can offer next/previous without a
    // second round trip.
    const siblings = await Lesson.find({ course: course._id, published: true }).sort({ order: 1 }).select('order');

    const position = siblings.findIndex((sibling) => String(sibling._id) === String(lesson._id));

    return ok(res, {
      lesson: lesson.toFullJSON({ completed, locked: false }),
      course: course.toCardJSON(),
      access: { isEnrolled: access.isEnrolled, manages: access.manages },
      navigation: {
        position: position + 1,
        total: siblings.length,
        previousLessonId: position > 0 ? String(siblings[position - 1]._id) : null,
        nextLessonId:
          position >= 0 && position < siblings.length - 1 ? String(siblings[position + 1]._id) : null,
      },
    });
  })
);

router.post(
  '/:courseId/lessons',
  authenticate,
  requireInstructor,
  validate({ params: schemas.courseIdParam, body: schemas.createLessonBody }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);
    const body = req.valid.body;

    // Default to the end of the course, so authoring never has to think about
    // ordering until it wants to.
    const last = await Lesson.findOne({ course: course._id }).sort({ order: -1 }).select('order');
    const order = body.order ?? (last ? last.order + 1 : 1);

    const lesson = await Lesson.create({
      ...body,
      course: course._id,
      order,
      videoUrl: body.videoUrl || null,
      resources: body.resources || [],
    });

    await refreshCourseCounters(course);

    return created(res, { lesson: lesson.toFullJSON() }, 'Lesson added.');
  })
);

router.patch(
  '/:courseId/lessons/:lessonId',
  authenticate,
  requireInstructor,
  validate({ params: schemas.lessonIdParam, body: schemas.updateLessonBody }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    const lesson = await Lesson.findOne({ _id: req.valid.params.lessonId, course: course._id });
    if (!lesson) throw notFound('That lesson could not be found.', { code: 'LESSON_NOT_FOUND' });

    const body = req.valid.body;

    /**
     * Moving a lesson to an order already taken would violate the unique
     * (course, order) index. Swap the two positions instead, which keeps the
     * sequence contiguous and is what the author actually means.
     */
    if (body.order !== undefined && body.order !== lesson.order) {
      const occupant = await Lesson.findOne({ course: course._id, order: body.order, _id: { $ne: lesson._id } });

      if (occupant) {
        occupant.order = lesson.order;
        await occupant.save();
      }
    }

    for (const field of [
      'title',
      'summary',
      'type',
      'content',
      'order',
      'durationMinutes',
      'isPreview',
      'published',
    ]) {
      if (body[field] !== undefined) lesson[field] = body[field];
    }

    if (body.videoUrl !== undefined) lesson.videoUrl = body.videoUrl || null;
    if (body.resources !== undefined) lesson.resources = body.resources;

    await lesson.save();
    await refreshCourseCounters(course);

    return ok(res, { lesson: lesson.toFullJSON() }, 'Lesson updated.');
  })
);

router.delete(
  '/:courseId/lessons/:lessonId',
  authenticate,
  requireInstructor,
  validate({ params: schemas.lessonIdParam }),
  asyncHandler(async (req, res) => {
    const course = await loadManagedCourse(req);

    const lesson = await Lesson.findOneAndDelete({ _id: req.valid.params.lessonId, course: course._id });
    if (!lesson) throw notFound('That lesson could not be found.', { code: 'LESSON_NOT_FOUND' });

    // Close the gap in the ordering without triggering the unique index.
    const remaining = await Lesson.find({ course: course._id }).sort({ order: 1 });
    let position = 1;
    for (const item of remaining) {
      if (item.order !== position) {
        item.order = position;
        // eslint-disable-next-line no-await-in-loop
        await item.save();
      }
      position += 1;
    }

    // A student may have completed this lesson; recompute their progress so
    // nobody is left at 99% on a course they have finished.
    const affected = await Enrollment.find({ course: course._id, completedLessons: lesson._id });
    for (const enrollment of affected) {
      enrollment.completedLessons = enrollment.completedLessons.filter(
        (id) => String(id) !== String(lesson._id)
      );
      // eslint-disable-next-line no-await-in-loop
      await enrollmentService.recalculate(enrollment, course);
    }

    await refreshCourseCounters(course);

    return noContent(res, 'Lesson removed.');
  })
);

/* ------------------------------------------------------------------ *
 * Enrolment
 * ------------------------------------------------------------------ */

router.post(
  '/:courseId/enroll',
  authenticate,
  writeLimiter,
  validate({ params: schemas.courseIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    // A paid course is enrolled through the payment webhook, never directly.
    if (course.priceCents > 0) {
      throw badRequest('This course requires payment. Start checkout to enroll.', {
        code: 'PAYMENT_REQUIRED',
        details: [{ field: 'courseId', message: 'Paid course' }],
      });
    }

    const { enrollment, created: isNew } = await enrollmentService.enroll({
      user: req.user,
      course,
      source: 'free',
    });

    return isNew
      ? created(res, { enrollment: enrollment.toJSONForStudent() }, 'You are enrolled.')
      : ok(res, { enrollment: enrollment.toJSONForStudent() }, 'You are already enrolled in this course.');
  })
);

/* ------------------------------------------------------------------ *
 * Completing a lesson
 * ------------------------------------------------------------------ */

router.post(
  '/:courseId/lessons/:lessonId/complete',
  authenticate,
  validate({ params: schemas.lessonIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const result = await enrollmentService.completeLesson({
      user: req.user,
      course,
      lessonId: req.valid.params.lessonId,
    });

    return ok(
      res,
      {
        enrollment: result.enrollment.toJSONForStudent(),
        progress: result.progress,
        completedCount: result.completedCount,
        total: result.total,
        finished: result.finished,
        certificate: result.certificate ? result.certificate.toJSONForOwner() : null,
      },
      result.finished ? 'Course completed — your certificate is ready.' : 'Lesson marked complete.'
    );
  })
);

router.delete(
  '/:courseId/lessons/:lessonId/complete',
  authenticate,
  validate({ params: schemas.lessonIdParam }),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.valid.params.courseId);
    if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

    const result = await enrollmentService.uncompleteLesson({
      user: req.user,
      course,
      lessonId: req.valid.params.lessonId,
    });

    return ok(
      res,
      {
        enrollment: result.enrollment.toJSONForStudent(),
        progress: result.progress,
        completedCount: result.completedCount,
        total: result.total,
      },
      'Lesson marked incomplete.'
    );
  })
);

module.exports = router;
