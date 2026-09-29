'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

const messageSchema = new mongoose.Schema(
  {
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'Thread', required: true, index: true },

    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    senderName: { type: String, trim: true, default: '' },
    senderAvatar: { type: String, trim: true, default: null },

    content: { type: String, required: [true, 'Message cannot be empty'], trim: true, maxlength: 5000 },

    /** Read receipts: user ids that have seen this message. */
    readBy: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },

    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  baseOptions
);

// Reading a conversation is always "this thread, oldest first" or
// "this thread, newest first" for pagination.
messageSchema.index({ thread: 1, createdAt: 1 });
messageSchema.index({ thread: 1, createdAt: -1 });

messageSchema.methods.toJSONFor = function toJSONFor(viewerId, extra = {}) {
  const viewer = viewerId ? String(viewerId) : null;

  return {
    id: String(this._id),
    threadId: String(this.thread),
    senderId: String(this.sender._id || this.sender),
    senderName: this.senderName,
    senderAvatar: this.senderAvatar,
    content: this.deletedAt ? 'This message was deleted' : this.content,
    deleted: Boolean(this.deletedAt),
    editedAt: this.editedAt,
    readByCount: this.readBy.length,
    isMine: viewer ? String(this.sender._id || this.sender) === viewer : false,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model('Message', messageSchema);
