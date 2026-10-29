#!/usr/bin/env node
'use strict';

/**
 * Give every course a lesson a visitor can read without enrolling.
 *
 * The flag this sets, `Lesson.isPreview`, already existed and was already wired
 * through the model, the validator, the syllabus (`locked`), the lesson route
 * (`mayRead`) and the course page's Preview chip. What it never had was a
 * writer: `generate-courses.js` did not set it, so not one of the 46 generated
 * courses had a readable lesson. Every syllabus row was locked, and the branch
 * that releases a lesson to a visitor could not fire.
 *
 *   npm run lessons:preview            # report only, writes nothing
 *   npm run lessons:preview -- --commit
 *
 * Rules, in order of importance:
 *
 *   1. It never removes a preview. A course deliberately offering three is left
 *      alone; only a course offering none is changed.
 *   2. It picks the first *published* lesson by `order`. An unpublished lesson
 *      1 would set a flag nobody could reach, because the syllabus hides
 *      unpublished lessons from visitors.
 *   3. It is idempotent. Running it twice writes once, and the second run says
 *      so.
 *
 * The generator now sets the flag itself, so this exists for the courses that
 * were written before it did — and as the repair for anything created by hand
 * through the API without ticking the box.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/db');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');

const shouldCommit = process.argv.includes('--commit');
const onlySlug = (process.argv.find((argument) => argument.startsWith('--course=')) || '').slice('--course='.length);

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Which lesson to mark, given a course's lessons in `order`.
 *
 * Separated out and exported so the rule can be tested without a database: the
 * three cases are "already has one", "has none but nothing published", and the
 * ordinary one. It takes plain objects, not Lesson documents, so it tests the
 * decision rather than mongoose.
 */
function choosePreview(lessons) {
  const already = lessons.filter((lesson) => lesson.isPreview);
  if (already.length > 0) return { action: 'left alone', lesson: already[0], existing: already.length };

  const candidate = lessons.find((lesson) => lesson.published);
  if (!candidate) return { action: 'skipped', lesson: null, existing: 0 };

  return { action: 'mark', lesson: candidate, existing: 0 };
}

async function main() {
  await db.connect();

  const filter = onlySlug ? { slug: onlySlug } : {};
  const courses = await Course.find(filter).sort({ createdAt: 1 }).select('title slug status');

  if (courses.length === 0) {
    process.stderr.write(`\nNo course matches ${onlySlug || '(all)'}.\n\n`);
    process.exitCode = 1;
    return;
  }

  const rows = [];

  for (const course of courses) {
    const lessons = await Lesson.find({ course: course._id }).sort({ order: 1 }).select('title order published isPreview');

    const choice = choosePreview(lessons);

    if (choice.action === 'left alone') {
      rows.push({
        slug: course.slug,
        action: 'left alone',
        detail: `${choice.existing} preview lesson(s) already, first is "${choice.lesson.title}"`,
      });
      continue;
    }

    if (choice.action === 'skipped') {
      rows.push({ slug: course.slug, action: 'skipped', detail: 'no published lesson to preview' });
      continue;
    }

    if (shouldCommit) {
      await Lesson.updateOne({ _id: choice.lesson._id }, { $set: { isPreview: true } });
    }

    rows.push({
      slug: course.slug,
      action: shouldCommit ? 'marked' : 'would mark',
      detail: `lesson ${choice.lesson.order}: ${choice.lesson.title}`,
    });
  }

  const width = rows.reduce((max, row) => Math.max(max, row.slug.length), 0);
  const changed = rows.filter((row) => row.action === 'marked' || row.action === 'would mark');

  process.stdout.write(
    [
      '',
      shouldCommit ? 'Marking a preview lesson per course.' : 'Dry run — nothing was written.',
      '',
      ...rows.map((row) => `  ${pad(row.slug, width)}  ${pad(row.action, 11)} ${row.detail}`),
      '',
      `${changed.length} course(s) ${shouldCommit ? 'changed' : 'would change'} of ${courses.length}.`,
      shouldCommit ? '' : 'Re-run with --commit to write.',
      '',
    ].join('\n')
  );

  await db.disconnect();
}

/**
 * Only when run as a command. The smoke suite imports `choosePreview` from
 * here, and an unguarded `main()` would open a database connection to test a
 * five-line decision.
 */
if (require.main === module) {
  main().catch(async (error) => {
    process.stderr.write(`\npreview lessons: ${error.message}\n\n`);
    process.exitCode = 1;
    try {
      await db.disconnect();
    } catch {
      /* the connection may never have opened */
    }
  });
}

module.exports = { choosePreview };
