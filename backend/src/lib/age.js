'use strict';

/**
 * Age, derived from a stored date of birth.
 *
 * The database holds a date, never an age. An age written down is wrong from
 * the next birthday onward and has to be swept clean every year; a date of
 * birth stays true forever, and age is one subtraction away whenever it is
 * actually needed.
 *
 * Everything here works in UTC, because a date of birth is a calendar date and
 * not an instant. A student born at 21:00 in Monrovia is still born that day.
 */

/** The youngest age the academy accepts. */
const MINIMUM_AGE = 16;

/**
 * A sanity ceiling, not a policy.
 *
 * It exists so a mistyped year (1023, or 2202) is caught as a typo rather than
 * quietly accepted as a very old, or a not-yet-born, student.
 */
const MAXIMUM_AGE = 120;

/** Nothing before this is accepted; the school was founded long after 1900. */
const EARLIEST_DATE_OF_BIRTH = '1900-01-01';

/**
 * The message a refused sign-up sees.
 *
 * Stated plainly, with a way to ask a human, because a bare "invalid date" on
 * a sixteen-year-old's birthday is confusing and a dead end.
 */
const MINIMUM_AGE_MESSAGE =
  'You must be at least 16 years old to create an account. Contact info@wuteveglobalacademy.com if you have questions.';

/**
 * Whole years between a date of birth and a reference date.
 *
 * Counts completed years: a birthday that has not happened yet this year does
 * not count, which is what "at least 16" has to mean to be honest.
 */
function ageInYears(dateOfBirth, now = new Date()) {
  const birth = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
  if (Number.isNaN(birth.getTime())) return null;

  let age = now.getUTCFullYear() - birth.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }

  return age;
}

/**
 * Parse a `YYYY-MM-DD` string into a UTC-midnight Date.
 *
 * Returns null for anything that is not a real calendar date. The round-trip
 * check matters: `new Date('2023-02-30')` rolls forward to 2 March instead of
 * failing, so a mistyped February birthday would otherwise be silently
 * rewritten to a different day.
 */
function parseDateOfBirth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;

  const text = value.trim();
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== text) return null;

  return parsed;
}

/** `YYYY-MM-DD` for a stored date, or null. Used when sending a profile back. */
function formatDateOfBirth(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

module.exports = {
  MINIMUM_AGE,
  MAXIMUM_AGE,
  EARLIEST_DATE_OF_BIRTH,
  MINIMUM_AGE_MESSAGE,
  ageInYears,
  parseDateOfBirth,
  formatDateOfBirth,
};
