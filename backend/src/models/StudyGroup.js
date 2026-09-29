'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

const studyGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Group name is required'], trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },

    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Participant ids, including the creator. Drives membership checks. */
    members: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [], index: true },

    isPrivate: { type: Boolean, default: false },
    maxMembers: { type: Number, default: 50, min: 2, max: 500 },

    /** The conversation that belongs to this group, if one has been created. */
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'Thread', default: null },
  },
  baseOptions
);

studyGroupSchema.index({ course: 1, isPrivate: 1, createdAt: -1 });

studyGroupSchema.methods.hasMember = function hasMember(userId) {
  if (!userId) return false;
  return this.members.some((member) => String(member) === String(userId));
};

studyGroupSchema.methods.toJSONFor = function toJSONFor(viewerId, extra = {}) {
  return {
    id: String(this._id),
    name: this.name,
    description: this.description,
    courseId: this.course ? String(this.course) : null,
    memberCount: this.members.length,
    maxMembers: this.maxMembers,
    isPrivate: this.isPrivate,
    isMember: this.hasMember(viewerId),
    isOwner: String(this.createdBy) === String(viewerId),
    threadId: this.thread ? String(this.thread) : null,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model('StudyGroup', studyGroupSchema);
