'use strict';

const { z } = require('zod');

const { ROLES, COURSE_LEVELS, COURSE_STATUSES, LESSON_TYPES } = require('../lib/constants');
const {
  MINIMUM_AGE,
  MAXIMUM_AGE,
  EARLIEST_DATE_OF_BIRTH,
  MINIMUM_AGE_MESSAGE,
  ageInYears,
  parseDateOfBirth,
} = require('../lib/age');

/**
 * Reusable field schemas.
 *
 * Every field is a concrete scalar. That is what makes object-based injection
 * impossible: `{ email: { $ne: null } }` fails `z.string().email()` and never
 * reaches a query.
 */

/** Trim and lowercase, so "User@Example.COM " and "user@example.com" are one account. */
const email = z
  .string({ required_error: 'Email is required', invalid_type_error: 'Email must be text' })
  .trim()
  .toLowerCase()
  .min(5, 'Email is too short')
  .max(254, 'Email is too long')
  .email('Enter a valid email address');

const name = z
  .string({ required_error: 'This field is required', invalid_type_error: 'This field must be text' })
  .trim()
  .min(1, 'This field is required')
  .max(80, 'This field is too long');

/**
 * Password policy, enforced on the server.
 * Upper bound is 72 bytes because bcrypt silently ignores anything beyond it —
 * accepting a longer password would mean a user could not sign in with it.
 */
const password = z
  .string({ required_error: 'Password is required', invalid_type_error: 'Password must be text' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

/**
 * Date of birth, validated and converted to a Date in one pass.
 *
 * The client sends `YYYY-MM-DD` — a calendar date, with no time and no zone —
 * because that is what a date input produces and what a birthday means. Sending
 * it as a timestamp would let a timezone move it to the previous day.
 *
 * The minimum age is enforced here, where the value is first trusted. It is
 * re-checked on any later edit for the same reason: a rule that only applies at
 * sign-up is a rule anyone can step around by editing their profile.
 */
const dateOfBirth = z
  .string({ required_error: 'Date of birth is required', invalid_type_error: 'Enter your date of birth' })
  .trim()
  .min(1, 'Date of birth is required')
  .transform((value, ctx) => {
    const parsed = parseDateOfBirth(value);

    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid date of birth' });
      return z.NEVER;
    }

    if (parsed.toISOString().slice(0, 10) < EARLIEST_DATE_OF_BIRTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid date of birth' });
      return z.NEVER;
    }

    const age = ageInYears(parsed);

    if (age === null || age > MAXIMUM_AGE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid date of birth' });
      return z.NEVER;
    }

    if (age < MINIMUM_AGE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MINIMUM_AGE_MESSAGE });
      return z.NEVER;
    }

    return parsed;
  });

/** Where the student is. Free text, but it must actually say something. */
const location = z
  .string({ required_error: 'Location is required', invalid_type_error: 'Enter your location' })
  .trim()
  .min(2, 'Enter your city and country')
  .max(100, 'Location is too long');

const phone = z
  .string()
  .trim()
  .max(32, 'Phone number is too long')
  .regex(/^[+()\d\s-]*$/, 'Enter a valid phone number')
  .optional()
  .or(z.literal(''));

const objectId = z
  .string({ invalid_type_error: 'Identifier must be text' })
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

/** Accepts a URL or an empty string (which is normalised to null). */
const optionalUrl = z
  .string()
  .trim()
  .max(2000, 'URL is too long')
  .url('Enter a valid URL')
  .optional()
  .or(z.literal(''))
  .nullable();

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

const registerBody = z.object({
  firstName: name,
  lastName: name,
  email,
  password,
  phone: phone.optional(),
  dateOfBirth,
  location,
  /**
   * `role` is intentionally absent. The previous API read a role straight from
   * the request body, which let anyone create an administrator account. Zod
   * strips unknown keys, so even the new client cannot reintroduce the field.
   */
});

const loginBody = z.object({
  email,
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required').max(72),
});

const refreshBody = z.object({
  // Optional: the browser client may instead send the token as a cookie.
  refreshToken: z.string().trim().min(20).max(500).optional(),
});

const logoutBody = z.object({
  refreshToken: z.string().trim().min(20).max(500).optional(),
  allDevices: z.coerce.boolean().optional().default(false),
});

const forgotPasswordBody = z.object({ email });

const resetPasswordBody = z.object({
  token: z.string().trim().min(20, 'This link is not valid').max(500),
  password,
});

const changePasswordBody = z.object({
  currentPassword: z.string({ required_error: 'Your current password is required' }).min(1).max(72),
  newPassword: password,
});

const updateProfileBody = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    phone: phone.optional(),
    bio: z.string().trim().max(600, 'Bio is too long').optional(),
    avatarUrl: optionalUrl.optional(),
    headline: z.string().trim().max(120, 'Headline is too long').optional(),
    expertise: z.array(z.string().trim().min(1).max(60)).max(20, 'Too many expertise tags').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const verifyEmailBody = z.object({ token: z.string().trim().min(20).max(500) });

const resendVerificationBody = z.object({ email });

const listUsersQuery = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  q: z.string().trim().max(120).optional(),
  page: paginationQuery.shape.page,
  limit: paginationQuery.shape.limit,
});

const updateUserBody = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    phone: phone.optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    emailVerified: z.coerce.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

module.exports = {
  // primitives
  objectId,
  email,
  name,
  password,
  phone,
  dateOfBirth,
  location,
  optionalUrl,
  paginationQuery,
  // auth
  registerBody,
  loginBody,
  refreshBody,
  logoutBody,
  forgotPasswordBody,
  resetPasswordBody,
  changePasswordBody,
  updateProfileBody,
  verifyEmailBody,
  resendVerificationBody,
  // users
  listUsersQuery,
  updateUserBody,
  // enums re-exported for route schemas
  enums: { ROLES, COURSE_LEVELS, COURSE_STATUSES, LESSON_TYPES },
};
