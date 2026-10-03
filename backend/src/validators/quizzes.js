'use strict';

const { z } = require('zod');

const { objectId } = require('./auth');

/**
 * Quiz input.
 *
 * The rule that matters most is that every question has exactly one right answer.
 * A question with none can never be scored, so it would quietly cost the student
 * marks whoever they are; a question with two makes "correct" ambiguous and would
 * mark a defensible answer wrong. Both are refused at the door rather than
 * discovered by a student.
 */

const optionBody = z.object({
  text: z.string().trim().min(1, 'Option text is required').max(500, 'Option text is too long'),
  isCorrect: z.coerce.boolean().optional().default(false),
});

const questionBody = z
  .object({
    prompt: z.string().trim().min(2, 'Question text is required').max(1000, 'Question is too long'),
    kind: z.enum(['single', 'true_false']).optional().default('single'),
    explanation: z.string().trim().max(1000, 'Explanation is too long').optional().default(''),
    points: z.coerce.number().int().min(1, 'Points must be at least 1').max(100, 'Points is too large').optional().default(1),
    options: z
      .array(optionBody)
      .min(2, 'A question needs at least two options')
      .max(10, 'A question can have at most ten options'),
  })
  .superRefine((question, ctx) => {
    const correct = question.options.filter((option) => option.isCorrect).length;

    if (correct === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Mark one option as the correct answer',
      });
    }

    if (correct > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Only one option can be the correct answer',
      });
    }

    // True/false is the same shape as a single choice, pinned to two options —
    // otherwise it is just a multiple-choice question wearing a different label.
    if (question.kind === 'true_false' && question.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A true/false question must have exactly two options',
      });
    }
  });

const quizBody = z.object({
  title: z.string().trim().min(1).max(200).optional().default('Quiz'),
  passPercent: z.coerce
    .number()
    .int()
    .min(0, 'Pass mark cannot be negative')
    .max(100, 'Pass mark cannot exceed 100')
    .optional()
    .default(70),
  // 0 is unlimited, which is a clearer default than picking an arbitrary number.
  maxAttempts: z.coerce.number().int().min(0).max(100, 'That is too many attempts').optional().default(0),
  questions: z
    .array(questionBody)
    .min(1, 'A quiz needs at least one question')
    .max(100, 'A quiz can have at most 100 questions'),
});

const submitAttemptBody = z.object({
  answers: z
    .array(
      z.object({
        questionId: objectId,
        // An array because the storage shape allows multi-select later. Today
        // every question has one right answer, and the grader compares the
        // selection exactly, so a padded selection is wrong rather than
        // partially right.
        optionIds: z.array(objectId).max(10, 'Too many options selected').optional().default([]),
      })
    )
    .max(200, 'Too many answers')
    .optional()
    .default([]),
});

module.exports = {
  quizBody,
  submitAttemptBody,
};
