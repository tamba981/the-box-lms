'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

const replySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true, default: '' },
    userAvatar: { type: String, trim: true, default: null },
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

/**
 * A discussion thread inside a course.
 *
 * Replies are embedded rather than a separate collection: a course discussion
 * is read as a whole page, the volume per thread is small, and embedding keeps
 * a thread render to a single document read.
 */
const communityPostSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, trim: true, default: '' },
    userAvatar: { type: String, trim: true, default: null },
    userRole: { type: String, trim: true, default: 'student' },

    title: { type: String, required: [true, 'Post title is required'], trim: true, maxlength: 200 },
    content: { type: String, required: [true, 'Post body is required'], trim: true, maxlength: 20000 },

    /** Optional link to a specific lesson, for a question about one lesson. */
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },

    likes: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
    replyCount: { type: Number, default: 0, min: 0 },

    pinned: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },

    /** Soft delete, so a removed post does not leave orphaned replies. */
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseOptions
);

communityPostSchema.index({ course: 1, pinned: -1, createdAt: -1 });
communityPostSchema.index({ course: 1, deletedAt: 1 });

communityPostSchema.methods.toJSONForViewer = function toJSONForViewer(viewerId, extra = {}) {
  const viewer = viewerId ? String(viewerId) : null;
  // Guarded against a projection that omitted `likes`.
  const likes = Array.isArray(this.likes) ? this.likes : [];

  return {
    id: String(this._id),
    courseId: String(this.course),
    lessonId: this.lesson ? String(this.lesson) : null,
    title: this.deletedAt ? 'This post was removed' : this.title,
    content: this.deletedAt ? '' : this.content,
    author: {
      id: String(this.user._id || this.user),
      name: this.userName,
      avatarUrl: this.userAvatar,
      role: this.userRole,
    },
    likeCount: likes.length,
    likedByViewer: viewer ? likes.some((id) => String(id) === viewer) : false,
    replyCount: this.replyCount,
    pinned: this.pinned,
    locked: this.locked,
    deleted: Boolean(this.deletedAt),
    isMine: viewer ? String(this.user._id || this.user) === viewer : false,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    ...extra,
  };
};

communityPostSchema.methods.toThreadJSON = function toThreadJSON(viewerId, extra = {}) {
  const viewer = viewerId ? String(viewerId) : null;

  return {
    ...this.toJSONForViewer(viewerId),
    replies: this.replies.map((reply) => ({
      id: String(reply._id),
      author: {
        id: String(reply.user._id || reply.user),
        name: reply.userName,
        avatarUrl: reply.userAvatar,
      },
      content: reply.content,
      isMine: viewer ? String(reply.user._id || reply.user) === viewer : false,
      createdAt: reply.createdAt,
      editedAt: reply.editedAt,
    })),
    ...extra,
  };
};

// `replies` lives here rather than inline in the schema definition above only
// to keep the two sub-documents visually separate.
communityPostSchema.add({ replies: { type: [replySchema], default: [] } });

module.exports = mongoose.model('CommunityPost', communityPostSchema);
