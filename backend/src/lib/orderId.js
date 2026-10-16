'use strict';

const crypto = require('crypto');

/**
 * Human-readable order references for manual payments.
 *
 * Format: `WGA-<unix milliseconds>-<6 characters>`, e.g.
 * `WGA-1792134843905-IPFQN8`.
 *
 * A student reads this number out over the phone, or types it into a mobile
 * money app as the payment reference, to whoever confirms their payment. So the
 * alphabet excludes every character that gets misheard or mistyped: 0, O, 1 and
 * I are gone. L stays, because the 1 it could be confused with does not exist
 * here.
 *
 * The alphabet is exactly 32 characters, which is not a coincidence — 256 is a
 * whole multiple of 32, so taking a byte modulo the length is uniform. A 30- or
 * 36-character alphabet would make the first few characters very slightly more
 * likely than the rest. It would not matter for a value that is not a secret,
 * but there is no reason to leave the flaw in when the alphabet fixes it.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SUFFIX_LENGTH = 6;

/** Six characters of a 32-symbol alphabet: 30 bits, or about a billion orders. */
function randomSuffix(length = SUFFIX_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let suffix = '';

  for (let position = 0; position < length; position += 1) {
    suffix += ALPHABET[bytes[position] % ALPHABET.length];
  }

  return suffix;
}

function newOrderId(now = Date.now()) {
  return `WGA-${now}-${randomSuffix()}`;
}

/** True only for strings this module could have produced. */
function isOrderId(value) {
  return new RegExp(`^WGA-\\d{10,16}-[${ALPHABET}]{${SUFFIX_LENGTH}}$`).test(String(value ?? ''));
}

module.exports = { newOrderId, isOrderId, ALPHABET, SUFFIX_LENGTH };
