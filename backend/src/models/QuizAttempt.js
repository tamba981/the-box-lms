'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * One submission of a quiz.
 *
 * Attempts are kept rather than overwritten, because three separate things need
 * the history: the attempt limit has to count them, the instructor wants to see
 * who struggled, and a certificate grade is only honest if it can say what it was
 * computed from.
 *
 * The awarded points are stored per answer rather than recomputed later. If an
 * instructor edits the quiz after a student sat it, the earlier attempt must keep
 * describing what that student was actually asked — recalculating it against the
 * new answer key would silently rewrite history.
 */

const answerSchema = new mongoose.Schema(
  {
    question: { type: mongoose.Schema.Types.ObjectId, required: true },
    selected: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    correct: { type: Boolean, default: false },
    awarded: { type: Number, default: 0 },
  },
  { _id: false }
);

const attemptSchema = new mongoose.Schema(
  {
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', required: true, index: true },

    answers: { type: [answerSchema], default: [] },

    pointsEarned: { type: Number, min: 0, default: 0 },
    pointsPossible: { type: Number, min: 0, default: 0 },
    scorePercent: { type: Number, min: 0, max: 100, default: 0 },
    passed: { type: Boolean, default: false },
  },
  baseOptions
);

// The attempt limit and "your previous attempts" both read this shape.
attemptSchema.index({ quiz: 1, student: 1, createdAt: -1 });
attemptSchema.index({ student: 1, course: 1 });

/**
 * What the student sees afterwards.
 *
 * `includeKey` adds the correct options and the explanations, and is only ever
 * passed once the attempt has been submitted — at which point withholding them
 * would be pointless. Before submitting, nothing on this object exists to leak.
 */
attemptSchema.methods.toResultJSON = function toResultJSON({ includeKey = false, quiz = null } = {}) {
  const key = includeKey && quiz ? quiz.answerKey() : null;
  const keyById = new Map((key || []).map((entry) => [entry.id, entry]));

  return {
    id: String(this._id),
    quiz: String(this.quiz),
    lesson: String(this.lesson),
    scorePercent: this.scorePercent,
    pointsEarned: this.pointsEarned,
    pointsPossible: this.pointsPossible,
    passed: this.passed,
    submittedAt: this.createdAt,
    answers: (this.answers || []).map((answer) => {
      const entry = keyById.get(String(answer.question));
      return {
        question: String(answer.question),
        selected: (answer.selected || []).map(String),
        correct: answer.correct,
        awarded: answer.awarded,
        ...(entry ? { explanation: entry.explanation, correctOptionIds: entry.correctOptionIds } : {}),
      };
    }),
  };
};

// A student's own attempts, newest first, is the read that matters most.
attemptSchema.index({ student: 1, lesson: 1, createdAt: -1 });

module.exports = mongoose.model('QuizAttempt', attemptSchema);
