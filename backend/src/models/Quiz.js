'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * A quiz attached to one lesson.
 *
 * One quiz per lesson, not a bank of many. A lesson is the unit a student works
 * through, so "the quiz for lesson 3" is the only thing that needs to exist, and
 * a pass mark and attempt limit are properties of that one quiz.
 *
 * Options are embedded inside questions rather than living in their own
 * collection. They are never read except with their question, never shared
 * between questions, and always written together — a separate collection would
 * add a join and a consistency risk for nothing.
 *
 * Every read goes through toStudentJSON() or toAuthorJSON(). There is deliberately
 * no "return the document" path, because the default serialisation of this model
 * contains the answers.
 */

const optionSchema = new mongoose.Schema(
  {
    text: { type: String, required: [true, 'Option text is required'], trim: true, maxlength: 500 },
    isCorrect: { type: Boolean, default: false },
  },
  { _id: true }
);

const questionSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: [true, 'Question text is required'], trim: true, maxlength: 1000 },

    /** `single` is one right answer; `true_false` is the same shape, fixed pair. */
    kind: { type: String, enum: ['single', 'true_false'], default: 'single' },

    /** Shown after submitting, never before. */
    explanation: { type: String, trim: true, maxlength: 1000, default: '' },

    /** Weight, so a long question can count for more than a short one. */
    points: { type: Number, min: 1, max: 100, default: 1 },

    options: { type: [optionSchema], default: [] },

    order: { type: Number, min: 1, default: 1 },
  },
  { _id: true }
);

const quizSchema = new mongoose.Schema(
  {
    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
      unique: true,
      index: true,
    },
    // Denormalised so a course-wide score can be summed without joining lessons.
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    title: { type: String, trim: true, maxlength: 200, default: 'Quiz' },

    passPercent: { type: Number, min: 0, max: 100, default: 70 },

    /** 0 means unlimited, which is friendlier than guessing a number. */
    maxAttempts: { type: Number, min: 0, max: 100, default: 0 },

    questions: { type: [questionSchema], default: [] },
  },
  baseOptions
);

quizSchema.methods.totalPoints = function totalPoints() {
  return (this.questions || []).reduce((sum, question) => sum + (question.points || 1), 0);
};

quizSchema.methods.questionCount = function questionCount() {
  return (this.questions || []).length;
};

/**
 * What a student may see. Note what is missing.
 *
 * `isCorrect` is dropped from every option and `explanation` is withheld. Both are
 * the answer key: leaving either in the payload would let anyone read the answers
 * out of the network tab, and the only thing grading on the server would protect
 * is the score display. Grading happens in the route precisely so this can be true.
 */
quizSchema.methods.toStudentJSON = function toStudentJSON(extra = {}) {
  const questions = (this.questions || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((question) => ({
      id: String(question._id),
      prompt: question.prompt,
      kind: question.kind,
      points: question.points,
      // Deliberately no `explanation` and no `isCorrect`.
      options: (question.options || []).map((option) => ({
        id: String(option._id),
        text: option.text,
      })),
    }));

  return {
    id: String(this._id),
    lesson: String(this.lesson),
    title: this.title,
    passPercent: this.passPercent,
    maxAttempts: this.maxAttempts,
    questionCount: questions.length,
    totalPoints: this.totalPoints(),
    questions,
    ...extra,
  };
};

/** What the instructor who owns the lesson sees — the same, plus the answer key. */
quizSchema.methods.toAuthorJSON = function toAuthorJSON(extra = {}) {
  return {
    ...this.toStudentJSON(),
    questions: (this.questions || [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((question) => ({
        id: String(question._id),
        prompt: question.prompt,
        kind: question.kind,
        points: question.points,
        explanation: question.explanation || '',
        order: question.order,
        options: (question.options || []).map((option) => ({
          id: String(option._id),
          text: option.text,
          isCorrect: Boolean(option.isCorrect),
        })),
      })),
    ...extra,
  };
};

/**
 * Grade a set of answers.
 *
 * Runs here rather than in the route so there is exactly one implementation of
 * what "correct" means, and so it can be tested without HTTP.
 *
 * An answer is correct only when the selection matches the key exactly. That
 * matters more than it looks: comparing "contains a correct option" would mark a
 * response right that also ticks three wrong boxes.
 *
 * @param {Array<{questionId: string, optionIds: string[]}>} submitted
 * @returns {{results: Array, pointsEarned: number, pointsPossible: number, scorePercent: number, passed: boolean}}
 */
quizSchema.methods.grade = function grade(submitted) {
  const byQuestion = new Map();
  (submitted || []).forEach((answer) => {
    if (answer && answer.questionId) byQuestion.set(String(answer.questionId), answer);
  });

  let pointsEarned = 0;
  let pointsPossible = 0;

  const results = (this.questions || []).map((question) => {
    const weight = question.points || 1;
    pointsPossible += weight;

    const key = (question.options || [])
      .filter((option) => option.isCorrect)
      .map((option) => String(option._id))
      .sort();

    const answer = byQuestion.get(String(question._id));
    // Only ids that actually belong to this question count, so an unknown id
    // cannot be used to pad a selection.
    const chosenIds = new Set((question.options || []).map((option) => String(option._id)));
    const chosen = (answer && Array.isArray(answer.optionIds) ? answer.optionIds : [])
      .map(String)
      .filter((id) => chosenIds.has(id))
      .sort();

    const correct = key.length > 0 && chosen.length === key.length && chosen.every((id, i) => id === key[i]);
    if (correct) pointsEarned += weight;

    return {
      question: question._id,
      selected: chosen.map((id) => mongoose.Types.ObjectId.createFromHexString(id)),
      correct,
      awarded: correct ? weight : 0,
    };
  });

  const scorePercent = pointsPossible > 0 ? Math.round((pointsEarned / pointsPossible) * 100) : 0;

  return {
    results,
    pointsEarned,
    pointsPossible,
    scorePercent,
    passed: scorePercent >= this.passPercent,
  };
};

/** The answer key, for marking a submitted attempt. Never sent to a student. */
quizSchema.methods.answerKey = function answerKey() {
  return (this.questions || []).map((question) => ({
    id: String(question._id),
    explanation: question.explanation || '',
    correctOptionIds: (question.options || [])
      .filter((option) => option.isCorrect)
      .map((option) => String(option._id)),
  }));
};

module.exports = mongoose.model('Quiz', quizSchema);
