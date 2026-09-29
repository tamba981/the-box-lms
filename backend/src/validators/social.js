'use strict';

const { z } = require('zod');

const { objectId } = require('./auth');

const page = z.coerce.number().int().min(1).max(10000).optional();
const limit = z.coerce.number().int().min(1).max(100).optional();

/**
 * A reusable pagination query schema.
 *
 * This must be a `z.object`, not a bare `{ page, limit }` literal: the validate
 * middleware calls `.parse()` on whatever it is given, so a plain object throws
 * `parse is not a function` at request time — a 500 on a route that looks wired
 * up correctly and passes any test that only checks authentication.
 */
const pagination = z.object({ page, limit });

/* ------------------------------------------------------------------ *
 * Community
 * ------------------------------------------------------------------ */

const listPostsQuery = z.object({
  courseId: objectId.optional(),
  lessonId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  unanswered: z.enum(['true', 'false']).optional(),
  page,
  limit,
});

const createPostBody = z.object({
  courseId: objectId,
  lessonId: objectId.optional().nullable(),
  title: z.string().trim().min(4, 'Give your post a title').max(200, 'Title is too long'),
  content: z.string().trim().min(2, 'Write something in your post').max(20000, 'Post is too long'),
});

const updatePostBody = z
  .object({
    title: z.string().trim().min(4, 'Give your post a title').max(200).optional(),
    content: z.string().trim().min(2, 'Write something in your post').max(20000).optional(),
    pinned: z.coerce.boolean().optional(),
    locked: z.coerce.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const replyBody = z.object({
  content: z.string().trim().min(2, 'Write a reply').max(5000, 'Reply is too long'),
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

const startThreadBody = z.object({
  recipientId: objectId,
  message: z.string().trim().max(5000).optional(),
  subject: z.string().trim().max(160).optional(),
});

const threadIdParam = z.object({ threadId: objectId });

const sendMessageBody = z.object({
  content: z.string().trim().min(1, 'Message cannot be empty').max(5000, 'Message is too long'),
});

const listMessagesQuery = z.object({
  before: objectId.optional(),
  page,
  limit,
});

/* ------------------------------------------------------------------ *
 * Study groups
 * ------------------------------------------------------------------ */

const listGroupsQuery = z.object({
  courseId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  page,
  limit,
});

const createGroupBody = z.object({
  name: z.string().trim().min(3, 'Group name is required').max(120, 'Group name is too long'),
  description: z.string().trim().max(1000, 'Description is too long').optional(),
  courseId: objectId.optional().nullable(),
  isPrivate: z.coerce.boolean().optional(),
  maxMembers: z.coerce.number().int().min(2).max(500).optional(),
});

const groupIdParam = z.object({ id: objectId });

/* ------------------------------------------------------------------ *
 * Live sessions
 * ------------------------------------------------------------------ */

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date and time')
  .transform((value) => new Date(value));

const listSessionsQuery = z.object({
  courseId: objectId.optional(),
  scope: z.enum(['upcoming', 'past', 'all']).optional().default('upcoming'),
  page,
  limit,
});

const createSessionBody = z
  .object({
    courseId: objectId,
    title: z.string().trim().min(3, 'Session title is required').max(200, 'Title is too long'),
    description: z.string().trim().max(2000, 'Description is too long').optional(),
    startTime: isoDate,
    endTime: isoDate,
    meetingLink: z.string().trim().url('Enter a valid meeting link').max(2000).optional(),
  })
  .refine((value) => value.endTime.getTime() > value.startTime.getTime(), {
    message: 'The end time must be after the start time',
    path: ['endTime'],
  });

const updateSessionBody = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    startTime: isoDate.optional(),
    endTime: isoDate.optional(),
    meetingLink: z.string().trim().url('Enter a valid meeting link').max(2000).optional().or(z.literal('')),
    recordingUrl: z.string().trim().url('Enter a valid URL').max(2000).optional().or(z.literal('')),
    status: z.enum(['scheduled', 'live', 'ended', 'cancelled']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const sessionIdParam = z.object({ id: objectId });

module.exports = {
  pagination,
  // community
  listPostsQuery,
  createPostBody,
  updatePostBody,
  replyBody,
  // messaging
  startThreadBody,
  threadIdParam,
  sendMessageBody,
  listMessagesQuery,
  // groups
  listGroupsQuery,
  createGroupBody,
  groupIdParam,
  // live sessions
  listSessionsQuery,
  createSessionBody,
  updateSessionBody,
  sessionIdParam,
};
