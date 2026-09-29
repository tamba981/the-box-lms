'use strict';

/**
 * Text helpers.
 *
 * `escapeRegex` exists because a search box feeds a MongoDB `$regex`. Without
 * escaping, a user typing `(a+)+$` supplies the pattern themselves; with it,
 * their input is only ever matched literally.
 */
function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A `$regex` source that matches anywhere in the field, case-insensitively. */
function contains(value) {
  return new RegExp(escapeRegex(value).trim(), 'i');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Strip whitespace-heavy markup from a plain-text preview. */
function preview(value, max = 160) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

module.exports = { escapeRegex, contains, truncate, preview };
