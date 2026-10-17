'use strict';

/**
 * Move courses onto the current category vocabulary.
 *
 *   node scripts/migrate-categories.js            # prints the plan, writes nothing
 *   node scripts/migrate-categories.js --apply    # performs it
 *
 * Dry run is the default on purpose: this writes to the database that production
 * also reads, and a migration that changes rows before anyone has seen what it
 * intends to do is a migration nobody can approve.
 *
 * What it will not do:
 *
 *   - Touch archived courses. They are internal test artifacts, they are already
 *     excluded from the catalogue and from the category facets by `status`, and
 *     filing them under a real category would invent content that does not exist.
 *   - Guess. A category it cannot map is reported as unmapped and left exactly
 *     as it was, rather than being pushed into the nearest-looking bucket.
 *
 * Running it twice changes nothing the second time.
 */

const db = require('../src/db');
const Course = require('../src/models/Course');
const { COURSE_CATEGORY_SLUGS, LEGACY_CATEGORY_ALIASES } = require('../src/lib/constants');

const APPLY = process.argv.includes('--apply');
const KNOWN = new Set(COURSE_CATEGORY_SLUGS);

(async () => {
  await db.connect();

  const courses = await Course.find({}).sort({ status: 1, title: 1 });
  const planned = [];
  const unmapped = [];
  const skipped = [];

  for (const course of courses) {
    const from = String(course.category || '').trim().toLowerCase();

    // Archived courses are deliberately out of scope; so are drafts that already
    // hold a current slug.
    if (course.status === 'archived') {
      skipped.push(course);
      continue;
    }

    if (KNOWN.has(from)) continue;

    const to = LEGACY_CATEGORY_ALIASES[from];

    if (!to) {
      unmapped.push(course);
      continue;
    }

    planned.push({ course, from, to });
  }

  console.log('');
  console.log('  ' + (APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'));
  console.log('  ' + courses.length + ' course(s) examined');
  console.log('');

  if (planned.length) {
    console.log('  will change (' + planned.length + '):');
    for (const row of planned) {
      console.log('    ' + String(row.course.status).padEnd(10) + row.from.padEnd(16) + '-> ' + row.to.padEnd(24) + row.course.title);
    }
  } else {
    console.log('  nothing to change — every course already uses a current category.');
  }

  if (skipped.length) {
    console.log('');
    console.log('  skipped as archived (' + skipped.length + '):');
    for (const course of skipped) {
      console.log('    ' + String(course.category).padEnd(16) + course.title);
    }
  }

  if (unmapped.length) {
    console.log('');
    console.log('  COULD NOT MAP (' + unmapped.length + ') — left untouched, fix these by hand:');
    for (const course of unmapped) {
      console.log('    ' + String(course.category).padEnd(16) + course.title);
    }
  }

  if (APPLY && planned.length) {
    for (const row of planned) {
      await Course.updateOne({ _id: row.course._id }, { $set: { category: row.to } });
    }
    console.log('');
    console.log('  wrote ' + planned.length + ' course(s).');
  }

  if (!APPLY && planned.length) {
    console.log('');
    console.log('  Re-run with --apply to make these changes.');
  }

  await db.disconnect();
  process.exit(unmapped.length ? 1 : 0);
})().catch(async (error) => {
  console.error('  FAILED: ' + error.message);
  try {
    await db.disconnect();
  } catch (_) {
    /* the connection may never have opened */
  }
  process.exit(1);
});
