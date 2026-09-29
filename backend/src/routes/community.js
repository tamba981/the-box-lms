'use strict';

const express = require('express');
const { z } = require('zod');

const CommunityPost = require('../models/CommunityPost');
const Course = require('../models/Course');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const permissions = require('../lib/permissions');
const { preview } = require('../lib/text');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/social');

const router = express.Router();

const objectIdString = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
const postIdParam = z.object({ id: objectIdString });

/**
 * Course discussions.
 *
 * Access mirrors the course itself: you must be enrolled, or be the instructor
 * or an admin, to read or post. A discussion attached to a course is therefore
 * exactly as private as the course.
 */
async function assertCourseMembership(user, courseId) {
  const course = await Course.findById(courseId);
  if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

  const access = await permissions.resolveCourseAccess(user, course);
  if (!access.canReadContent) {
    throw forbidden('Enroll in this course to join the discussion.', { code: 'ENROLLMENT_REQUIRED' });
  }

  return { course, access };
}

function authorFields(user) {
  return {
    userName: user.fullName,
    userAvatar: user.avatarUrl,
    userRole: user.role,
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/v1/community/posts
 * ------------------------------------------------------------------ */

router.get(
  '/posts',
  authenticate,
  validate({ query: schemas.listPostsQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const filter = { deletedAt: null };

    if (query.courseId) {
      await assertCourseMembership(req.user, query.courseId);
      filter.course = query.courseId;
    } else {
      // Without a course filter, show discussions from courses the viewer can
      // actually see rather than everything on the platform.
      const visible = await visibleCourseIds(req.user);
      filter.course = { $in: visible };
    }

    if (query.lessonId) filter.lesson = query.lessonId;
    if (query.mine === 'true') filter.user = req.user._id;
    if (query.unanswered === 'true') filter.replyCount = 0;

    const [posts, total] = await Promise.all([
      CommunityPost.find(filter).sort({ pinned: -1, createdAt: -1 }).skip(skip).limit(limit),
      CommunityPost.countDocuments(filter),
    ]);

    return ok(res, {
      ...paginated(
        posts.map((post) => post.toJSONForViewer(req.user._id)),
        total,
        { page, limit }
      ),
    });
  })
);

/** Course ids the viewer is enrolled in, plus any they teach. */
async function visibleCourseIds(user) {
  const Enrollment = require('../models/Enrollment');

  const [enrollments, teaching] = await Promise.all([
    Enrollment.find({ student: user._id, status: { $ne: 'cancelled' } }).select('course'),
    Course.find({ instructor: user._id }).select('_id'),
  ]);

  return [...enrollments.map((enrollment) => enrollment.course), ...teaching.map((course) => course._id)];
}

/* ------------------------------------------------------------------ *
 * POST /api/v1/community/posts
 * ------------------------------------------------------------------ */

router.post(
  '/posts',
  authenticate,
  writeLimiter,
  validate({ body: schemas.createPostBody }),
  asyncHandler(async (req, res) => {
    const { courseId, title, content, lessonId } = req.valid.body;

    await assertCourseMembership(req.user, courseId);

    const post = await CommunityPost.create({
      course: courseId,
      lesson: lessonId || null,
      user: req.user._id,
      title,
      content,
      ...authorFields(req.user),
    });

    return created(res, { post: post.toJSONForViewer(req.user._id) }, 'Posted.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/community/posts/:id
 * ------------------------------------------------------------------ */

router.get(
  '/posts/:id',
  authenticate,
  validate({ params: postIdParam }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    await assertCourseMembership(req.user, post.course);

    const course = await Course.findById(post.course).select('title slug');

    return ok(res, {
      post: post.toThreadJSON(req.user._id),
      course: course ? { id: String(course._id), title: course.title, slug: course.slug } : null,
    });
  })
);

/* ------------------------------------------------------------------ *
 * PATCH /api/v1/community/posts/:id
 * ------------------------------------------------------------------ */

router.patch(
  '/posts/:id',
  authenticate,
  writeLimiter,
  validate({ params: postIdParam, body: schemas.updatePostBody }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    const { course } = await assertCourseMembership(req.user, post.course);

    const isAuthor = String(post.user) === String(req.user._id);
    const isModerator = req.user.role === 'admin' || String(course.instructor) === String(req.user._id);

    if (!isAuthor && !isModerator) {
      throw forbidden('You can only edit your own posts.', { code: 'NOT_POST_AUTHOR' });
    }

    const body = req.valid.body;

    if (body.title !== undefined) post.title = body.title;
    if (body.content !== undefined) post.content = body.content;

    // Pinning and locking are moderation actions, not authoring actions.
    if (body.pinned !== undefined || body.locked !== undefined) {
      if (!isModerator) throw forbidden('Only the instructor can pin or lock a post.', { code: 'NOT_MODERATOR' });
      if (body.pinned !== undefined) post.pinned = body.pinned;
      if (body.locked !== undefined) post.locked = body.locked;
    }

    await post.save();

    return ok(res, { post: post.toJSONForViewer(req.user._id) }, 'Post updated.');
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/community/posts/:id ??? soft delete
 * ------------------------------------------------------------------ */

router.delete(
  '/posts/:id',
  authenticate,
  validate({ params: postIdParam }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    const { course } = await assertCourseMembership(req.user, post.course);

    const isAuthor = String(post.user) === String(req.user._id);
    const isModerator = req.user.role === 'admin' || String(course.instructor) === String(req.user._id);

    if (!isAuthor && !isModerator) {
      throw forbidden('You can only delete your own posts.', { code: 'NOT_POST_AUTHOR' });
    }

    /**
     * Soft delete. Removing the whole thread would also delete the replies
     * other people wrote, so the post becomes a tombstone instead and the
     * conversation it started stays readable.
     */
    post.deletedAt = new Date();
    post.deletedBy = req.user._id;
    await post.save();

    return noContent(res, 'Post removed.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/community/posts/:id/replies
 * ------------------------------------------------------------------ */

router.post(
  '/posts/:id/replies',
  authenticate,
  writeLimiter,
  validate({ params: postIdParam, body: schemas.replyBody }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    await assertCourseMembership(req.user, post.course);

    if (post.locked) throw badRequest('This discussion is locked.', { code: 'POST_LOCKED' });
    if (post.deletedAt) throw badRequest('This post was removed.', { code: 'POST_DELETED' });

    post.replies.push({
      user: req.user._id,
      userName: req.user.fullName,
      userAvatar: req.user.avatarUrl,
      content: req.valid.body.content,
    });

    post.replyCount = post.replies.length;
    await post.save();

    const reply = post.replies[post.replies.length - 1];

    return created(
      res,
      {
        reply: {
          id: String(reply._id),
          author: { id: String(req.user._id), name: req.user.fullName, avatarUrl: req.user.avatarUrl },
          content: reply.content,
          isMine: true,
          createdAt: reply.createdAt,
        },
        replyCount: post.replyCount,
      },
      'Reply posted.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/community/posts/:id/replies/:replyId
 * ------------------------------------------------------------------ */

router.delete(
  '/posts/:id/replies/:replyId',
  authenticate,
  validate({
    params: z.object({ id: objectIdString, replyId: objectIdString }),
  }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    const { course } = await assertCourseMembership(req.user, post.course);

    const reply = post.replies.id(req.valid.params.replyId);
    if (!reply) throw notFound('That reply could not be found.', { code: 'REPLY_NOT_FOUND' });

    const isAuthor = String(reply.user) === String(req.user._id);
    const isModerator = req.user.role === 'admin' || String(course.instructor) === String(req.user._id);

    if (!isAuthor && !isModerator) {
      throw forbidden('You can only delete your own replies.', { code: 'NOT_REPLY_AUTHOR' });
    }

    reply.deleteOne();
    post.replyCount = post.replies.length;
    await post.save();

    return noContent(res, 'Reply removed.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/community/posts/:id/like ??? toggle
 * ------------------------------------------------------------------ */

router.post(
  '/posts/:id/like',
  authenticate,
  validate({ params: postIdParam }),
  asyncHandler(async (req, res) => {
    const post = await CommunityPost.findById(req.valid.params.id);
    if (!post) throw notFound('That post could not be found.', { code: 'POST_NOT_FOUND' });

    await assertCourseMembership(req.user, post.course);

    const alreadyLiked = post.likes.some((id) => String(id) === String(req.user._id));

    // One toggle endpoint rather than separate like/unlike calls, so the two
    // can never disagree about the current state.
    if (alreadyLiked) {
      post.likes = post.likes.filter((id) => String(id) !== String(req.user._id));
    } else {
      post.likes.push(req.user._id);
    }

    await post.save();

    return ok(
      res,
      { liked: !alreadyLiked, likeCount: post.likes.length },
      alreadyLiked ? 'Like removed.' : 'Liked.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/community/activity ??? recent discussions for the dashboard
 * ------------------------------------------------------------------ */

router.get(
  '/activity',
  authenticate,
  asyncHandler(async (req, res) => {
    const visible = await visibleCourseIds(req.user);

    const posts = await CommunityPost.find({ course: { $in: visible }, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(8);

    const courses = await Course.find({ _id: { $in: posts.map((post) => post.course) } }).select('title');

    const titlesById = new Map(courses.map((course) => [String(course._id), course.title]));

    return ok(res, {
      posts: posts.map((post) =>
        post.toJSONForViewer(req.user._id, {
          courseTitle: titlesById.get(String(post.course)) || null,
          excerpt: preview(post.content, 160),
        })
      ),
    });
  })
);

module.exports = router;
