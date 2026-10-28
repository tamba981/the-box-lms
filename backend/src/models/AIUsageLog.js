'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

const AI_ACTIONS = Object.freeze([
  'tutor',
  'mentor',
  'assessment',
  'insights',
  'feedback',
  'tutor_refunded',
]);

/**
 * One row per AI request that reached the provider, plus the ones refused for
 * credits.
 *
 * This exists for two different questions, and they want different data:
 *
 *   - "what is this costing?" needs tokens, because the provider bills per token
 *     and a credit scheme that is not reconciled against real usage drifts
 *   - "what are students actually asking?" needs the question, which is why a
 *     short, trimmed copy of it is kept for tutor calls only
 *
 * The question is truncated and stored deliberately: it is the only way to tell
 * an instructor which part of their lesson students keep stumbling on, and it is
 * disclosed on the privacy page. Everything else here is metadata.
 */
const aiUsageLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: AI_ACTIONS, required: true, index: true },

    credits: { type: Number, default: 0, min: 0 },

    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },

    /** Tutor questions only, trimmed to 200 characters. */
    question: { type: String, default: null, maxlength: 200 },

    model: { type: String, default: null },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    /** Derived from the token counts at the rates in config; not a bill. */
    estimatedCostUsd: { type: Number, default: 0 },

    latencyMs: { type: Number, default: 0 },
    ok: { type: Boolean, default: true },
    /** A short reason when the request failed after being allowed. */
    error: { type: String, default: null, maxlength: 200 },
  },
  baseOptions
);

aiUsageLogSchema.index({ user: 1, createdAt: -1 });
aiUsageLogSchema.index({ action: 1, createdAt: -1 });
aiUsageLogSchema.index({ course: 1, createdAt: -1 });

module.exports = mongoose.model('AIUsageLog', aiUsageLogSchema);
module.exports.AI_ACTIONS = AI_ACTIONS;
