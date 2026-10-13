'use strict';

const crypto = require('crypto');

/**
 * A random password that always satisfies the server's policy.
 *
 * The policy is at least eight characters with at least one letter and at least
 * one number (`validators/auth.js`). `base64url` supplies the letters and the
 * length, but it does **not** guarantee a digit: its alphabet is 64 characters of
 * which only ten are digits, so roughly one twelve-character draw in seven has
 * none — and a password that fails the policy is a password nobody can use.
 *
 * So the digits are appended deliberately rather than hoped for, and the shape is
 * fixed rather than random. It lives here rather than in each caller because there
 * are two of them — the seed script and the administrator's reset route — and a
 * second copy is how one of them quietly stops matching the policy.
 */
function generatePassword() {
  const body = crypto.randomBytes(6).toString('base64url');
  const digits = crypto.randomInt(1000, 9999);

  return `Wga-${body}-${digits}!7`;
}

module.exports = { generatePassword };
