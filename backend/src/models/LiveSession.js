'use strict';

const mongoose = require('mongoose');

const { LIVE_SESSION_STATUSES } = require('../lib/constants');
const { baseOptions } = require('./common');

const liveSessionSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Session title is required'], trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },

    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    courseTitle: { type: String, trim: true, default: '' },

    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    instructorName: { type: String, trim: true, default: '' },

    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: true },

    /**
     * The join link is only ever returned to enrolled students, an instructor
     * of the course, or an admin. It must not appear in catalog responses.
     */
    meetingLink: { type: String, trim: true, default: null, select: false },
    recordingUrl: { type: String, trim: true, default: null },

    status: { type: String, enum: LIVE_SESSION_STATUSES, default: 'scheduled', index: true },

    attendees: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  baseOptions
);

liveSessionSchema.index({ course: 1, startTime: -1 });
liveSessionSchema.index({ startTime: 1, status: 1 });

liveSessionSchema.methods.hasEnded = function hasEnded() {
  return this.status === 'ended' || this.endTime.getTime() < Date.now();
};

liveSessionSchema.methods.toJSONFor = function toJSONFor(viewer, options = {}) {
  const { canJoin = false } = options;

  return {
    id: String(this._id),
    courseId: String(this.course),
    courseTitle: this.courseTitle,
    title: this.title,
    description: this.description,
    instructorName: this.instructorName,
    startTime: this.startTime,
    endTime: this.endTime,
    durationMinutes: Math.max(0, Math.round((this.endTime - this.startTime) / 60000)),
    status: this.hasEnded() && this.status === 'scheduled' ? 'ended' : this.status,
    attendeeCount: this.attendees.length,
    isAttending: viewer ? this.attendees.some((id) => String(id) === String(viewer)) : false,
    // Never leaked: undefined keys are dropped by JSON.stringify.
    meetingLink: canJoin ? this.meetingLink : undefined,
    recordingUrl: canJoin && this.hasEnded() ? this.recordingUrl : undefined,
  };
};

module.exports = mongoose.model('LiveSession', liveSessionSchema);
