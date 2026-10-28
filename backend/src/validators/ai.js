'use strict';

const { z } = require('zod');

const objectId = (label) => z.string().trim().regex(/^[a-f\d]{24}$/i, `That ${label} is not valid`);

/** A question to the tutor, about one lesson. */
const tutorBody = z.object({
  lessonId: objectId('lesson'),
  question: z
    .string({ required_error: 'Type a question first' })
    .trim()
    .min(3, 'Type a question first')
    .max(1200, 'That question is too long — ask it in a sentence or two'),
});

/**
 * The mentor conversation.
 *
 * History arrives from the browser, so it is bounded in both dimensions: a
 * dozen turns, two thousand characters each. The service trims again, because a
 * limit on the request is not a limit on what the model is asked.
 */
const mentorBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(2000),
      })
    )
    .min(1, 'Say something first')
    .max(24, 'That conversation is too long — start a new one'),
});

const mentorNoteBody = z.object({
  note: z.string().trim().max(600).optional().default(''),
});

/** Five short answers. The keys are fixed so the prompt can label them. */
const assessmentBody = z.object({
  interests: z.string().trim().min(2, 'Tell us what interests you').max(600),
  strengths: z.string().trim().min(2, 'Tell us what you are good at').max(600),
  goal: z.string().trim().min(2, 'Tell us what you are working towards').max(600),
  timePerWeek: z.string().trim().min(1, 'How much time can you give it?').max(200),
  background: z.string().trim().max(600).optional().default(''),
});

const insightsQuery = z.object({
  courseId: objectId('course'),
});

/* ---- Buying credits ---- */

const orderIdParam = z.object({ id: objectId('order') });

const bundleBody = z.object({
  payerPhone: z.string().trim().max(40).optional().default(''),
});

const bundleSentBody = z.object({
  payerPhone: z.string().trim().max(40).optional().default(''),
});

/** The admin queue: approve or decline one order. */
const aiOrderDecisionBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(500).optional().default(''),
  })
  .refine((value) => value.decision !== 'rejected' || value.note.length >= 10, {
    message: 'Give a reason of at least 10 characters so the student knows why.',
    path: ['note'],
  });

const aiOrderListQuery = z.object({
  status: z.enum(['all', 'pending', 'awaiting_verification', 'paid', 'rejected', 'expired'])
    .optional()
    .default('awaiting_verification'),
});

const feedbackBody = z.object({
  courseId: objectId('course'),
  submission: z
    .string({ required_error: 'Paste the submission first' })
    .trim()
    .min(20, 'Paste at least a paragraph of the submission')
    .max(6000, 'That submission is too long to draft from — paste the relevant part'),
  rubric: z.string().trim().max(2000).optional().default(''),
});

module.exports = {
  tutorBody,
  mentorBody,
  mentorNoteBody,
  assessmentBody,
  insightsQuery,
  feedbackBody,
  orderIdParam,
  bundleBody,
  bundleSentBody,
  aiOrderDecisionBody,
  aiOrderListQuery,
};
