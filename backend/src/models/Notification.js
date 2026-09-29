'use strict';

const mongoose = require('mongoose');

const { NOTIFICATION_TYPES } = require('../lib/constants');
const { baseOptions } = require('./common');

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },

    type: { type: String, enum: NOTIFICATION_TYPES, default: 'announcement', index: true },

    /** In-app destination, e.g. `/student-dashboard.html#/courses/<id>`. */
    link: { type: String, trim: true, maxlength: 500, default: null },

    /** Free-form context (courseId, certificateNumber, ...) for the client. */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  baseOptions
);

// The notifications panel always queries "mine, newest first" and counts unread.
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });

notificationSchema.statics.notify = function notify(userId, payload) {
  return this.create({
    user: userId,
    title: payload.title,
    message: payload.message,
    type: payload.type || 'announcement',
    link: payload.link || null,
    meta: payload.meta || {},
  });
};

/** Fan out one announcement to many users in a single insert. */
notificationSchema.statics.notifyMany = function notifyMany(userIds, payload) {
  if (!userIds || userIds.length === 0) return Promise.resolve([]);

  return this.insertMany(
    userIds.map((userId) => ({
      user: userId,
      title: payload.title,
      message: payload.message,
      type: payload.type || 'announcement',
      link: payload.link || null,
      meta: payload.meta || {},
    }))
  );
};

module.exports = mongoose.model('Notification', notificationSchema);
