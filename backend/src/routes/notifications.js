'use strict';

const express = require('express');
const { z } = require('zod');

const Notification = require('../models/Notification');

const { asyncHandler } = require('../lib/asyncHandler');
const { ok, noContent } = require('../lib/respond');
const { notFound } = require('../lib/errors');
const { parsePagination, paginated } = require('../lib/pagination');

const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid notification reference');

/* ------------------------------------------------------------------ *
 * GET /api/v1/notifications
 * ------------------------------------------------------------------ */

router.get(
  '/',
  authenticate,
  validate({
    query: z.object({
      unreadOnly: z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => value === 'true'),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { limit, page, skip } = parsePagination(req.valid.query);

    const filter = { user: req.user._id };
    if (req.valid.query.unreadOnly) filter.read = false;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);

    return ok(res, {
      ...paginated(
        notifications.map((notification) => ({
          id: String(notification._id),
          title: notification.title,
          message: notification.message,
          type: notification.type,
          link: notification.link,
          meta: notification.meta,
          read: notification.read,
          createdAt: notification.createdAt,
        })),
        total,
        { page, limit }
      ),
      unreadCount,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/notifications/:id/read
 * ------------------------------------------------------------------ */

router.post(
  '/:id/read',
  authenticate,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    // The user id is part of the filter, so this can never mark someone else's
    // notification as read even if the id is guessed.
    const notification = await Notification.findOneAndUpdate(
      { _id: req.valid.params.id, user: req.user._id },
      { $set: { read: true, readAt: new Date() } },
      { new: true }
    );

    if (!notification) throw notFound('That notification could not be found.', { code: 'NOTIFICATION_NOT_FOUND' });

    const unreadCount = await Notification.countDocuments({ user: req.user._id, read: false });

    return ok(res, { id: String(notification._id), read: true, unreadCount }, 'Marked as read.');
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/v1/notifications/read-all
 * ------------------------------------------------------------------ */

router.post(
  '/read-all',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true, readAt: new Date() } }
    );

    return ok(res, { markedRead: result.modifiedCount, unreadCount: 0 }, 'All notifications marked as read.');
  })
);

/* ------------------------------------------------------------------ *
 * DELETE /api/v1/notifications/:id
 * ------------------------------------------------------------------ */

router.delete(
  '/:id',
  authenticate,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const result = await Notification.deleteOne({ _id: req.valid.params.id, user: req.user._id });
    if (result.deletedCount === 0) {
      throw notFound('That notification could not be found.', { code: 'NOTIFICATION_NOT_FOUND' });
    }

    return noContent(res, 'Notification dismissed.');
  })
);

module.exports = router;
