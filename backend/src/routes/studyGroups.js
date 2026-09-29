'use strict';

const express = require('express');
const { z } = require('zod');

const Course = require('../models/Course');
const StudyGroup = require('../models/StudyGroup');
const Thread = require('../models/Thread');

const notifications = require('../services/notificationService');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { notFound, forbidden, conflict, badRequest } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const permissions = require('../lib/permissions');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/social');

const router = express.Router();

/**
 * Study groups.
 *
 * Each group owns a conversation thread. Membership is the single authority:
 * joining adds you to the thread, leaving removes you, and the messaging
 * endpoints then enforce the rest without any group-specific rules.
 */

/* ------------------------------------------------------------------ *
 * GET /api/v1/study-groups
 * ------------------------------------------------------------------ */

router.get(
  '/',
  authenticate,
  validate({ query: schemas.listGroupsQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query;
    const { limit, page, skip } = parsePagination(query);

    const filter = {};

    if (query.mine === 'true') {
      filter.members = req.user._id;
    } else if (query.courseId) {
      await assertCourseAccess(req.user, query.courseId);
      filter.course = query.courseId;
      // Someone else's private group stays out of the list.
      filter.$or = [{ isPrivate: false }, { members: req.user._id }, { createdBy: req.user._id }];
    } else {
      filter.$or = [{ members: req.user._id }, { isPrivate: false }];
    }

    const [groups, total] = await Promise.all([
      StudyGroup.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      StudyGroup.countDocuments(filter),
    ]);

    return ok(
      res,
      paginated(
        groups.map((group) => group.toJSONFor(req.user._id)),
        total,
        { page, limit }
      )
    );
  })
);

async function assertCourseAccess(user, courseId) {
  const course = await Course.findById(courseId);
  if (!course) throw notFound('That course could not be found.', { code: 'COURSE_NOT_FOUND' });

  const access = await permissions.resolveCourseAccess(user, course);
  if (!access.canReadContent) {
    throw forbidden('Enroll in this course to use its study groups.', { code: 'ENROLLMENT_REQUIRED' });
  }

  return course;
}

/* ------------------------------------------------------------------ *
 * POST /api/v1/study-groups
 * ------------------------------------------------------------------ */

router.post(
  '/',
  authenticate,
  writeLimiter,
  validate({ body: schemas.createGroupBody }),
  asyncHandler(async (req, res) => {
    const { name, description, courseId, isPrivate, maxMembers } = req.valid.body;

    let course = null;

    if (courseId) {
      course = await assertCourseAccess(req.user, courseId);
    } else if (req.user.role === 'student') {
      // A study group without a course is fine for instructors and admins, but
      // a student's group should belong to something they are studying.
      throw badRequest('Choose a course for your study group.', {
        code: 'COURSE_REQUIRED',
        details: [{ field: 'courseId', message: 'A course is required' }],
      });
    }

    const group = await StudyGroup.create({
      name,
      description: description || '',
      course: course ? course._id : null,
      createdBy: req.user._id,
      members: [req.user._id],
      isPrivate: Boolean(isPrivate),
      maxMembers: maxMembers || 50,
    });

    // The group's conversation, with the creator already in it.
    const thread = await Thread.create({
      key: Thread.groupKey(group._id),
      type: 'group',
      title: name,
      participants: [req.user._id],
      course: course ? course._id : null,
      studyGroup: group._id,
      lastMessageAt: new Date(),
    });

    group.thread = thread._id;
    await group.save();

    return created(res, { group: group.toJSONFor(req.user._id) }, 'Study group created.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/study-groups/:id
 * ------------------------------------------------------------------ */

router.get(
  '/:id',
  authenticate,
  validate({ params: schemas.groupIdParam }),
  asyncHandler(async (req, res) => {
    const group = await StudyGroup.findById(req.valid.params.id);
    if (!group) throw notFound('That study group could not be found.', { code: 'GROUP_NOT_FOUND' });

    const isMember = group.hasMember(req.user._id);

    // A private group is invisible to non-members.
    if (group.isPrivate && !isMember && String(group.createdBy) !== String(req.user._id)) {
      throw notFound('That study group could not be found.', { code: 'GROUP_NOT_FOUND' });
    }

    const members = await require('../models/User')
      .find({ _id: { $in: group.members } })
      .select('firstName lastName role avatarUrl');

    return ok(res, {
      group: group.toJSONFor(req.user._id),
      members: members.map((member) => ({
        id: String(member._id),
        name: member.fullName,
        role: member.role,
        avatarUrl: member.avatarUrl,
      })),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/study-groups/:id/join
 * ------------------------------------------------------------------ */

router.post(
  '/:id/join',
  authenticate,
  validate({ params: schemas.groupIdParam }),
  asyncHandler(async (req, res) => {
    const group = await StudyGroup.findById(req.valid.params.id);
    if (!group) throw notFound('That study group could not be found.', { code: 'GROUP_NOT_FOUND' });

    if (group.hasMember(req.user._id)) {
      return ok(res, { group: group.toJSONFor(req.user._id) }, 'You are already a member.');
    }

    if (group.members.length >= group.maxMembers) {
      throw conflict('This study group is full.', { code: 'GROUP_FULL' });
    }

    // A private group can only be joined through its thread invite, which the
    // creator controls.
    if (group.isPrivate) {
      throw forbidden('This is a private group. Ask the owner for an invitation.', { code: 'GROUP_PRIVATE' });
    }

    if (group.course) await assertCourseAccess(req.user, group.course);

    // `$addToSet` so a double-clicked Join cannot add the same member twice.
    await StudyGroup.updateOne({ _id: group._id }, { $addToSet: { members: req.user._id } });

    if (group.thread) {
      await Thread.updateOne({ _id: group.thread }, { $addToSet: { participants: req.user._id } });
    }

    notifications
      .notify(group.createdBy, {
        title: 'New study group member',
        message: `${req.user.fullName} joined "${group.name}".`,
        type: 'announcement',
        link: `/student-dashboard.html#/groups/${group._id}`,
      })
      .catch(() => {});

    const updated = await StudyGroup.findById(group._id);

    return ok(res, { group: updated.toJSONFor(req.user._id) }, 'You joined the group.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/study-groups/:id/leave
 * ------------------------------------------------------------------ */

router.post(
  '/:id/leave',
  authenticate,
  validate({ params: schemas.groupIdParam }),
  asyncHandler(async (req, res) => {
    const group = await StudyGroup.findById(req.valid.params.id);
    if (!group) throw notFound('That study group could not be found.', { code: 'GROUP_NOT_FOUND' });

    if (!group.hasMember(req.user._id)) {
      return ok(res, { group: group.toJSONFor(req.user._id) }, 'You are not a member of this group.');
    }

    // The owner leaving would orphan the group, so ownership passes on rather
    // than the group becoming unmanageable.
    if (String(group.createdBy) === String(req.user._id)) {
      const successor = group.members.find((member) => String(member) !== String(req.user._id));

      if (successor) {
        group.createdBy = successor;
        await StudyGroup.updateOne(
          { _id: group._id },
          { $pull: { members: req.user._id }, $set: { createdBy: successor } }
        );
      } else {
        // Last member out closes the group.
        await StudyGroup.deleteOne({ _id: group._id });
        if (group.thread) await Thread.deleteOne({ _id: group.thread });

        return noContent(res, 'You left the group. It has been closed as nobody else remained.');
      }
    } else {
      await StudyGroup.updateOne({ _id: group._id }, { $pull: { members: req.user._id } });
    }

    if (group.thread) {
      await Thread.updateOne({ _id: group.thread }, { $pull: { participants: req.user._id } });
    }

    const updated = await StudyGroup.findById(group._id);

    return ok(res, { group: updated ? updated.toJSONFor(req.user._id) : null }, 'You left the group.');
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/study-groups/:id — owner or admin
 * ------------------------------------------------------------------ */

router.delete(
  '/:id',
  authenticate,
  validate({ params: schemas.groupIdParam }),
  asyncHandler(async (req, res) => {
    const group = await StudyGroup.findById(req.valid.params.id);
    if (!group) throw notFound('That study group could not be found.', { code: 'GROUP_NOT_FOUND' });

    const isOwner = String(group.createdBy) === String(req.user._id);

    if (!isOwner && req.user.role !== 'admin') {
      throw forbidden('Only the group owner can delete it.', { code: 'NOT_GROUP_OWNER' });
    }

    await StudyGroup.deleteOne({ _id: group._id });
    if (group.thread) await Thread.deleteOne({ _id: group.thread });

    return noContent(res, 'Study group deleted.');
  })
);

module.exports = router;
