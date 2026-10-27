'use strict';

const { z } = require('zod');

const {
  ALLOWED_IMAGE_MIME,
  ALLOWED_MATERIAL_MIME,
  MAX_ADMISSION_UPLOAD_BYTES,
} = require('../lib/constants');

/**
 * Offline admission application.
 *
 * The public form is filled in by people who have never used this platform, so
 * every message here is written to be shown to them directly. The class list is
 * free text with a length limit rather than an enum: the offline programme can
 * add a class without a deploy, and refusing a class because it is not in a
 * hard-coded list is a worse failure than accepting one.
 */

const mobile = z
  .string()
  .trim()
  .min(7, 'Enter a phone number we can reach you on')
  .max(40, 'That phone number is too long')
  .regex(/^[0-9+()\-.\s]+$/, 'Use digits, spaces, and + ( ) - only');

const personName = (label) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(2, `${label} is required`)
    .max(80, `${label} is too long`)
    .regex(/^[\p{L}\p{M}'\-.\s]+$/u, `${label} may only contain letters, spaces, hyphens and apostrophes`);

const isoDate = z
  .string({ required_error: 'Enter your date of birth' })
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date')
  .transform((value) => new Date(value))
  .refine((date) => {
    const age = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return age >= 10 && age <= 100;
  }, 'Enter a date of birth for someone between 10 and 100 years old');

const uploadRef = z
  .string()
  .trim()
  .min(1, 'An upload key is required')
  .max(500);

const documentRef = z.object({
  key: uploadRef,
  name: z.string().trim().max(260).optional().default(''),
  size: z.coerce.number().int().min(0).max(MAX_ADMISSION_UPLOAD_BYTES).optional().default(0),
  mime: z.string().trim().max(120).optional().default(''),
});

const submitBody = z.object({
  classLevel: z
    .string({ required_error: 'Choose the class you are applying for' })
    .trim()
    .min(1, 'Choose the class you are applying for')
    .max(120, 'That class name is too long'),

  firstName: personName('First name'),
  lastName: personName('Last name'),
  gender: z.enum(['female', 'male', 'other', 'prefer_not_to_say'], {
    errorMap: () => ({ message: 'Choose a gender, or prefer not to say' }),
  }),
  dateOfBirth: isoDate,
  mobile,
  email: z
    .string({ required_error: 'Enter an email address' })
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(160, 'That email address is too long'),
  religion: z.string().trim().max(80).optional().default(''),

  /**
   * The photograph is strongly wanted but not a hard requirement.
   *
   * Requiring it would mean that any moment storage is misconfigured, nobody can
   * apply at all — and an admissions office would rather phone an applicant for a
   * photo than lose the application. When a key is given it is verified like any
   * other upload.
   */
  photoKey: uploadRef.optional().or(z.literal('')).default(''),
  photoMime: z.string().trim().max(120).optional().default(''),

  fatherName: z.string().trim().max(120).optional().default(''),
  fatherPhone: z.string().trim().max(40).optional().default(''),
  motherName: z.string().trim().max(120).optional().default(''),
  motherPhone: z.string().trim().max(40).optional().default(''),
  motherOccupation: z.string().trim().max(120).optional().default(''),

  previousSchool: z.string().trim().max(300).optional().default(''),

  documents: z.array(documentRef).max(6, 'Attach at most 6 documents').optional().default([]),

  /**
   * Consent is required, not implied. The form collects a minor's details and a
   * photograph, so the applicant (or their parent) has to say yes explicitly.
   */
  consent: z.literal(true, {
    errorMap: () => ({ message: 'Please confirm you agree to the academy storing these details' }),
  }),
});

const uploadBody = z.object({
  purpose: z.enum(['photo', 'document']),
  filename: z.string().trim().min(1, 'A filename is required').max(260, 'That filename is too long'),
  contentType: z.string().trim().toLowerCase(),
  sizeBytes: z.coerce
    .number({ invalid_type_error: 'A file size is required' })
    .int()
    .min(1, 'That file appears to be empty')
    .max(MAX_ADMISSION_UPLOAD_BYTES, 'Each file must be 5 MB or smaller'),
}).superRefine((value, ctx) => {
  const allowed = value.purpose === 'photo' ? ALLOWED_IMAGE_MIME : [...ALLOWED_IMAGE_MIME, ...ALLOWED_MATERIAL_MIME];

  if (!allowed.includes(value.contentType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentType'],
      message:
        value.purpose === 'photo'
          ? 'Upload a JPG, PNG or WebP photograph.'
          : 'Upload a PDF, image, Word, PowerPoint, Excel, text, CSV or ZIP file.',
    });
  }
});

/** `GET /admissions/status/:tracking` */
const trackingParam = z.object({
  tracking: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^WGA-ADM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/, 'That is not a Wuteve tracking number'),
});

const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending'),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ id: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid identifier') });

const approveBody = z.object({
  note: z.string().trim().max(500).optional().default(''),
});

const rejectBody = z.object({
  note: z
    .string({ required_error: 'Give a reason' })
    .trim()
    .min(10, 'Give a reason of at least 10 characters')
    .max(500, 'That reason is too long'),
});

module.exports = {
  submitBody,
  uploadBody,
  trackingParam,
  listQuery,
  idParam,
  approveBody,
  rejectBody,
};
