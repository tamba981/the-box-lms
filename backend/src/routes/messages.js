'use strict';

const express = require('express');
const { z } = require('zod');

const Message = require('../models/Message');
const Thread = require('../models/Thread');
const User = require('../models/User');

const notifications = require('../services/notificationService');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, created, noContent } = require('../lib/respond');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');
const { preview } = require('../lib/text');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/social');

const router = express.Router();

/**
 * Direct messaging.
 *
 * A thread is only ever readable by its participants. Every handler therefore
 * begins by loading the thread and checking membership — there is no route that
 * takes a message id and returns it without that check.
 */

async function loadThreadForParticipant(threadId, userId) {
  const thread = await Thread.findById(threadId);
  if (!thread) throw notFound('That conversation could not be found.', { code: 'THREAD_NOT_FOUND' });

  const isParticipant = thread.participants.some((participant) => String(participant) === String(userId));
  // 404 rather than 403: a stranger should not learn that a thread exists.
  if (!isParticipant) throw notFound('That conversation could not be found.', { code: 'THREAD_NOT_FOUND' });

  return thread;
}

/* ------------------------------------------------------------------ *
 * GET /api/v1/messages/threads
 * ------------------------------------------------------------------ */

router.get(
  '/threads',
  authenticate,
  validate({ query: schemas.pagination }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const [threads, total] = await Promise.all([
      Thread.find({ participants: req.user._id }).sort({ lastMessageAt: -1 }).skip(skip).limit(limit),
      Thread.countDocuments({ participants: req.user._id }),
    ]);

    // Resolve the other participants so the inbox can show names, in one query.
    const otherIds = [
      ...new Set(
        threads
          .flatMap((thread) => thread.participants.map(String))
          .filter((id) => id !== String(req.user._id))
      ),
    ];

    const others = await User.find({ _id: { $in: otherIds } }).select('firstName lastName role avatarUrl');

    const byId = new Map(others.map((user) => [String(user._id), user]));

    const items = threads.map((thread) => {
      const participants = thread.participants
        .map(String)
        .filter((id) => id !== String(req.user._id))
        .map((id) => {
          const user = byId.get(id);
          return user
            ? { id, name: user.fullName, role: user.role, avatarUrl: user.avatarUrl }
            : { id, name: 'Former member', role: null, avatarUrl: null };
        });

      return thread.toJSONFor(req.user._id, {
        participants,
        // A group thread keeps its own name; a direct thread is named after
        // whoever is on the other side.
        displayName: thread.title || participants.map((participant) => participant.name).join(', ') || 'Conversation',
        totalUnread: thread.unreadFor(req.user._id),
      });
    });

    const unreadTotal = threads.reduce((sum, thread) => sum + thread.unreadFor(req.user._id), 0);

    return ok(res, { ...paginated(items, total, { page, limit }), unreadTotal });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/messages/threads — open (or reuse) a direct conversation
 * ------------------------------------------------------------------ */

router.post(
  '/threads',
  authenticate,
  writeLimiter,
  validate({ body: schemas.startThreadBody }),
  asyncHandler(async (req, res) => {
    const { recipientId, message, subject } = req.valid.body;

    if (String(recipientId) === String(req.user._id)) {
      throw badRequest('You cannot start a conversation with yourself.', { code: 'SELF_THREAD' });
    }

    const recipient = await User.findById(recipientId).select('firstName lastName role avatarUrl');
    if (!recipient) throw notFound('That person could not be found.', { code: 'RECIPIENT_NOT_FOUND' });

    // Deterministic key, so both directions resolve to the same conversation.
    const key = Thread.directKey(req.user._id, recipientId);

    let thread = await Thread.findOne({ key });

    if (!thread) {
      try {
        thread = await Thread.create({
          key,
          type: 'direct',
          title: subject || null,
          participants: [req.user._id, recipientId],
          lastMessageAt: new Date(),
        });
      } catch (error) {
        // Two simultaneous opens both computed the same key; take the winner's.
        if (error && error.code === 11000) thread = await Thread.findOne({ key });
        if (!thread) throw error;
      }
    }

    let createdMessage = null;

    if (message) {
      createdMessage = await Message.create({
        thread: thread._id,
        sender: req.user._id,
        senderName: req.user.fullName,
        senderAvatar: req.user.avatarUrl,
        content: message,
      });

      thread.lastMessageAt = new Date();
      thread.lastMessagePreview = preview(message, 200);
      thread.lastMessageSender = req.user._id;
      thread.unread = { ...(thread.unread || {}), [String(recipientId)]: thread.unreadFor(recipientId) + 1 };
      await thread.save();

      notifications
        .onMessage(
          recipientId,
          req.user.fullName,
          preview(message),
          `/student-dashboard.html#/messages/${thread._id}`
        )
        .catch(() => {});
    }

    return created(
      res,
      {
        thread: thread.toJSONFor(req.user._id, {
          participants: [
            { id: String(recipient._id), name: recipient.fullName, role: recipient.role, avatarUrl: recipient.avatarUrl },
          ],
          displayName: recipient.fullName,
        }),
        message: createdMessage ? createdMessage.toJSONFor(req.user._id) : null,
      },
      'Conversation ready.'
    );
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/messages/threads/:threadId
 * ------------------------------------------------------------------ */

router.get(
  '/threads/:threadId',
  authenticate,
  validate({ params: schemas.threadIdParam, query: schemas.listMessagesQuery }),
  asyncHandler(async (req, res) => {
    const thread = await loadThreadForParticipant(req.valid.params.threadId, req.user._id);
    const { limit, page, skip } = parsePagination(req.valid.query);

    const filter = { thread: thread._id };
    if (req.valid.query.before) filter._id = { $lt: req.valid.query.before };

    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit),
      Message.countDocuments(filter),
    ]);

    const participants = await User.find({ _id: { $in: thread.participants } }).select(
      'firstName lastName role avatarUrl'
    );

    return ok(res, {
      thread: thread.toJSONFor(req.user._id, {
        participants: participants.map((user) => ({
          id: String(user._id),
          name: user.fullName,
          role: user.role,
          avatarUrl: user.avatarUrl,
        })),
      }),
      ...paginated(
        messages.map((message) => message.toJSONFor(req.user._id)),
        total,
        { page, limit }
      ),
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/messages/threads/:threadId
 * ------------------------------------------------------------------ */

router.post(
  '/threads/:threadId',
  authenticate,
  writeLimiter,
  validate({ params: schemas.threadIdParam, body: schemas.sendMessageBody }),
  asyncHandler(async (req, res) => {
    const thread = await loadThreadForParticipant(req.valid.params.threadId, req.user._id);

    const message = await Message.create({
      thread: thread._id,
      sender: req.user._id,
      senderName: req.user.fullName,
      senderAvatar: req.user.avatarUrl,
      content: req.valid.body.content,
    });

    const recipients = thread.participants
      .map(String)
      .filter((id) => id !== String(req.user._id));

    const unread = { ...(thread.unread || {}) };
    for (const id of recipients) unread[id] = (unread[id] || 0) + 1;

    thread.lastMessageAt = new Date();
    thread.lastMessagePreview = preview(req.valid.body.content, 200);
    thread.lastMessageSender = req.user._id;
    thread.unread = unread;
    await thread.save();

    // Notifications never block the send that triggered them.
    for (const id of recipients) {
      notifications
        .onMessage(id, req.user.fullName, preview(req.valid.body.content), `/student-dashboard.html#/messages/${thread._id}`)
        .catch(() => {});
    }

    return created(res, { message: message.toJSONFor(req.user._id) }, 'Message sent.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/messages/threads/:threadId/read
 * ------------------------------------------------------------------ */

router.post(
  '/threads/:threadId/read',
  authenticate,
  validate({ params: schemas.threadIdParam }),
  asyncHandler(async (req, res) => {
    const thread = await loadThreadForParticipant(req.valid.params.threadId, req.user._id);

    // Zero this participant's counter and record a read receipt on every
    // message from someone else in the thread.
    await Thread.updateOne(
      { _id: thread._id },
      { $set: { [`unread.${String(req.user._id)}`]: 0 } }
    );

    const result = await Message.updateMany(
      { thread: thread._id, sender: { $ne: req.user._id }, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );

    return ok(res, { markedRead: result.modifiedCount, unreadCount: 0 }, 'Conversation marked as read.');
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/v1/messages/unread-count — for the header badge
 * ------------------------------------------------------------------ */

router.get(
  '/unread-count',
  authenticate,
  asyncHandler(async (req, res) => {
    const threads = await Thread.find({ participants: req.user._id }).select('unread');

    const unread = threads.reduce((sum, thread) => sum + thread.unreadFor(req.user._id), 0);

    return ok(res, { unread });
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/messages/:messageId
 * ------------------------------------------------------------------ */

router.delete(
  '/:messageId',
  authenticate,
  validate({ params: z.object({ messageId: z.string().trim().regex(/^[a-f\d]{24}$/i) }) }),
  asyncHandler(async (req, res) => {
    const message = await Message.findById(req.valid.params.messageId);
    if (!message) throw notFound('That message could not be found.', { code: 'MESSAGE_NOT_FOUND' });

    await loadThreadForParticipant(message.thread, req.user._id);

    if (String(message.sender) !== String(req.user._id)) {
      throw forbidden('You can only delete your own messages.', { code: 'NOT_MESSAGE_AUTHOR' });
    }

    message.deletedAt = new Date();
    await message.save();

    return noContent(res, 'Message deleted.');
  })
);

module.exports = router;
