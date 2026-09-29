'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { THREAD_TYPES } = require('../lib/constants');
const { baseOptions } = require('./common');

/**
 * A conversation.
 *
 * `key` is the deduplication handle for direct messages: for a DM it is the
 * two participant ids sorted and joined, so "A messages B" and "B messages A"
 * always resolve to the same thread instead of creating a second one. For a
 * group thread it is the group id.
 */
const threadSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },

    type: { type: String, enum: THREAD_TYPES, default: 'direct' },

    title: { type: String, trim: true, maxlength: 160, default: null },

    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      index: true,
    },

    // Context, so an instructor conversation can be shown alongside its course.
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    studyGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'StudyGroup', default: null },

    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, trim: true, maxlength: 200, default: '' },
    lastMessageSender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /** Per-participant unread counters, keyed by user id. */
    unread: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  baseOptions
);

threadSchema.index({ participants: 1, lastMessageAt: -1 });

/** Deterministic DM key: order-independent, so it cannot be duplicated. */
threadSchema.statics.directKey = function directKey(userIdA, userIdB) {
  return [String(userIdA), String(userIdB)].sort().join(':');
};

threadSchema.statics.groupKey = function groupKey(groupId) {
  return `group:${String(groupId)}`;
};

threadSchema.statics.courseKey = function courseKey(courseId) {
  return `course:${String(courseId)}`;
};

threadSchema.statics.randomKey = function randomKey() {
  return `thread:${crypto.randomBytes(12).toString('hex')}`;
};

threadSchema.methods.unreadFor = function unreadFor(userId) {
  return this.unread?.[String(userId)] || 0;
};

threadSchema.methods.toJSONFor = function toJSONFor(userId, extra = {}) {
  return {
    id: String(this._id),
    type: this.type,
    title: this.title,
    participantIds: this.participants.map(String),
    participantCount: this.participants.length,
    courseId: this.course ? String(this.course) : null,
    lastMessageAt: this.lastMessageAt,
    lastMessagePreview: this.lastMessagePreview,
    lastMessageSenderId: this.lastMessageSender ? String(this.lastMessageSender) : null,
    unreadCount: this.unreadFor(userId),
    ...extra,
  };
};

module.exports = mongoose.model('Thread', threadSchema);
