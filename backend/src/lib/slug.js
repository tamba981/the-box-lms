'use strict';

/**
 * URL-safe slug generation and its inverse guard.
 *
 * Slugs are user-visible (course URLs) and must be unique, so `uniqueSlug`
 * takes a `exists` predicate and appends `-2`, `-3`, ... until it finds a
 * free name. It never trusts the input to be unique.
 */

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'item';
}

/**
 * @param {string} input
 * @param {(candidate: string) => Promise<boolean>} exists
 * @param {string} [ignoreId] document id to exclude from the uniqueness check
 */
async function uniqueSlug(input, exists, ignoreId) {
  const base = slugify(input);
  let candidate = base;
  let suffix = 2;

  // Bounded so a pathological predicate cannot spin forever.
  while (suffix < 500) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await exists(candidate, ignoreId))) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return `${base}-${Date.now()}`;
}

module.exports = { slugify, uniqueSlug };
