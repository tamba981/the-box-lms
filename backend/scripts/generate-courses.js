/**
 * Phase 2d — build the catalog from structured outlines.
 *
 * Every course is a JSON file under data/courses/. This script reads them,
 * checks them against the rules the database enforces, and either reports what
 * it would write or writes it.
 *
 *   npm run courses:dry                        report only, touches no database
 *   npm run courses:dry -- --program=FCP       one programme
 *   npm run courses:dry -- --course=<slug>     one course
 *   npm run courses:commit                     create or replace the courses
 *
 * Two authoring styles, one format. A `templated` course gives each lesson its
 * teaching paragraphs, an applied example, key points and a self-check, and the
 * composer below turns that into a lesson body. A `handwritten` course gives the
 * lesson HTML directly, because a flagship is not assembled from parts. Both
 * carry the same metadata and the same quiz shape, so the validator and the
 * report treat them alike.
 *
 * Idempotency: a course is matched by slug. Committing replaces that course's
 * lessons and quiz, the way scripts/seed-lse-course.js does, so re-running after
 * an edit does not duplicate anything. It refuses to rewrite a course somebody
 * has already started, because lesson ids are what a student's progress points
 * at, and `--force` is the deliberate override.
 *
 * Nothing here is published by accident: `--commit` writes `draft` unless
 * `--publish` is passed as well.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const {
  COURSE_CATEGORY_SLUGS,
  COURSE_LEVELS,
  CREDENTIALS,
  CERTIFICATE_FEE_OPTIONS,
} = require('../src/lib/constants');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'course-outlines.json');

const DEFAULT_MINUTES = 15;
/** The price ceiling the client set for this catalogue. */
const MAX_PRICE_CENTS = 5000;

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label}: cannot read ${path.relative(DATA_DIR, file)} (${error.code})`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${path.relative(DATA_DIR, file)} is not valid JSON — ${error.message}`);
  }
}

function loadManifest() {
  const manifest = readJson(MANIFEST_PATH, 'manifest');

  if (!Array.isArray(manifest.courses) || manifest.courses.length === 0) {
    throw new Error('manifest: no courses listed');
  }

  return manifest;
}

function loadCourse(manifest, entry) {
  const file = path.join(DATA_DIR, entry.file);
  const course = readJson(file, entry.slug);

  return { ...course, __file: path.relative(path.join(__dirname, '..'), file), __entry: entry, __manifest: manifest };
}

/* ------------------------------------------------------------------ *
 * Validation
 *
 * The same shape of checks the model applies, run here so that a mistake is
 * reported as "course X, lesson 7, field Y" before anything is written, rather
 * than as a Mongoose validation error during a 46-course commit.
 * ------------------------------------------------------------------ */

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

function requireString(where, value, field, max) {
  if (typeof value !== 'string' || !value.trim()) fail(where, `${field} must be a non-empty string`);
  if (max && value.length > max) fail(where, `${field} is ${value.length} characters, limit is ${max}`);
}

function validateCourse(course) {
  const where = course.slug || '(no slug)';
  const { __entry: entry, __manifest: manifest } = course;

  requireString(where, course.slug, 'slug');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(course.slug)) fail(where, 'slug must be lowercase words joined by hyphens');
  if (!course.slug.startsWith(`${path.basename(entry.file).replace(/\.json$/, '')}`)) {
    fail(where, `slug does not match its filename (${entry.file})`);
  }
  if (course.slug === 'liberia-stock-exchange') fail(where, 'the Liberia Stock Exchange course is not part of this catalogue');

  requireString(where, course.title, 'title', 160);

  // The manifest carries the title so a reviewer can read the whole catalogue
  // in one place. If the two disagree, the reviewer has been reading a plan
  // that is not the thing being written.
  requireString(where, entry.title, 'manifest title', 160);
  if (course.title !== entry.title) {
    fail(where, `title is "${course.title}" but the manifest says "${entry.title}"`);
  }
  requireString(where, course.summary, 'summary', 280);
  requireString(where, course.description, 'description', 20000);

  const program = manifest.programs[entry.program];
  if (!program) fail(where, `unknown programme "${entry.program}"`);

  if (course.program !== entry.program) fail(where, `program is "${course.program}" but the manifest says "${entry.program}"`);
  if (!COURSE_CATEGORY_SLUGS.includes(course.category)) {
    fail(where, `category "${course.category}" is not one of: ${COURSE_CATEGORY_SLUGS.join(', ')}`);
  }
  if (!COURSE_LEVELS.includes(course.level)) fail(where, `level "${course.level}" is not one of: ${COURSE_LEVELS.join(', ')}`);
  if (course.level !== program.level) fail(where, `level is "${course.level}" but ${entry.program} courses are "${program.level}"`);
  if (!CREDENTIALS.includes(course.credential)) fail(where, `credential "${course.credential}" is unknown`);
  if (course.credential !== program.credential) {
    fail(where, `credential is "${course.credential}" but ${entry.program} awards "${program.credential}"`);
  }

  // Pricing is declared twice on purpose: the manifest is the plan a reviewer
  // reads, the course file is what gets written. A disagreement is a bug.
  for (const field of ['priceCents', 'certificateFeeCents']) {
    if (course[field] !== entry[field]) fail(where, `${field} is ${course[field]} but the manifest says ${entry[field]}`);
  }

  if (!Number.isInteger(course.priceCents) || course.priceCents < 0) fail(where, 'priceCents must be a whole number of cents');
  if (course.priceCents > MAX_PRICE_CENTS) fail(where, `priceCents ${course.priceCents} exceeds the $50 ceiling`);
  if (!CERTIFICATE_FEE_OPTIONS.includes(course.certificateFeeCents)) {
    fail(where, `certificateFeeCents ${course.certificateFeeCents} is not one of: ${CERTIFICATE_FEE_OPTIONS.join(', ')}`);
  }
  if (course.certificateFeeCents > MAX_PRICE_CENTS) fail(where, 'certificateFeeCents exceeds the $50 ceiling');

  // The Foundation tier is the free on-ramp: it must never cost money to enrol.
  if (entry.program === 'FCP' && course.priceCents !== 0) fail(where, 'FCP courses must be free to enrol');
  if (entry.program !== 'FCP' && course.priceCents === 0) fail(where, `${entry.program} courses are paid; priceCents is 0`);
  if (course.priceCents > 0 && course.certificateFeeCents !== 0) {
    fail(where, 'a paid course bundles its credential; certificateFeeCents must be 0');
  }

  if (!Array.isArray(course.tags) || course.tags.length === 0) fail(where, 'tags must be a non-empty array');
  if (course.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) fail(where, 'every tag must be a non-empty string');
  if (!Array.isArray(course.outcomes) || course.outcomes.length < 3) fail(where, 'outcomes must list at least three things');

  if (!entry.type || !['templated', 'handwritten'].includes(entry.type)) fail(where, 'manifest type must be templated or handwritten');
  if (!Array.isArray(course.modules) || course.modules.length === 0) fail(where, 'modules must be a non-empty array');

  const lessons = [];
  course.modules.forEach((module, moduleIndex) => {
    requireString(where, module.title, `modules[${moduleIndex}].title`);
    if (!Array.isArray(module.lessons) || module.lessons.length === 0) {
      fail(where, `modules[${moduleIndex}].lessons must be a non-empty array`);
    }

    module.lessons.forEach((lesson, lessonIndex) => {
      const at = `${where} · module ${moduleIndex + 1} lesson ${lessonIndex + 1}`;
      requireString(at, lesson.title, 'title', 200);

      const hasHtml = lesson.html !== undefined;
      const hasTeach = Array.isArray(lesson.teach) && lesson.teach.length > 0;

      if (entry.type === 'handwritten' && !hasHtml) fail(at, 'a handwritten lesson must supply html');
      if (entry.type === 'templated' && hasHtml) fail(at, 'a templated lesson must supply teach, not html');
      if (!hasHtml && !hasTeach) fail(at, 'lesson has neither html nor teach');

      if (hasTeach) {
        lesson.teach.forEach((paragraph, index) => requireString(at, paragraph, `teach[${index}]`));
        requireString(at, lesson.example, 'example');
        if (!Array.isArray(lesson.points) || lesson.points.length < 3) fail(at, 'points must list at least three');
        lesson.points.forEach((point, index) => requireString(at, point, `points[${index}]`));
        requireString(at, lesson.check, 'check');
      }

      if (lesson.minutes !== undefined && (!Number.isInteger(lesson.minutes) || lesson.minutes < 1)) {
        fail(at, 'minutes must be a positive whole number');
      }

      lessons.push({ module: moduleIndex + 1, lesson });
    });
  });

  if (lessons.length < 8) fail(where, `only ${lessons.length} lessons; a course needs at least 8`);

  if (!Array.isArray(course.quiz) || course.quiz.length < 5) fail(where, 'quiz must have at least five questions');

  course.quiz.forEach((question, index) => {
    const at = `${where} · quiz question ${index + 1}`;
    requireString(at, question.prompt, 'prompt', 1000);
    if (question.explanation !== undefined) requireString(at, question.explanation, 'explanation', 1000);

    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 2) fail(at, 'needs at least two options');
    options.forEach((option, optionIndex) => requireString(at, option.text, `options[${optionIndex}].text`, 500));

    const correct = options.filter((option) => option.correct === true).length;
    if (correct !== 1) fail(at, `${correct} options marked correct; exactly one is required`);

    if (question.kind === 'true_false' && options.length !== 2) fail(at, 'a true/false question must have exactly two options');
  });

  return { lessons: lessons.length, questions: course.quiz.length };
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A lesson body from a templated lesson, or the author's own markup.
 *
 * The shape is the one the Liberia Stock Exchange course uses: prose, a heading
 * per movement, an applied example, a short list to hold on to, and a question
 * that sends the reader back into their own work. That structure is what makes a
 * lesson teach rather than describe, so it is fixed here rather than left to
 * each outline to remember.
 */
function composeHtml(lesson) {
  if (lesson.html !== undefined) {
    return Array.isArray(lesson.html) ? lesson.html.join('\n') : lesson.html;
  }

  const blocks = lesson.teach.map((paragraph) => `<p>${paragraph}</p>`);

  blocks.push('<h3>In practice</h3>', `<p>${lesson.example}</p>`);
  blocks.push('<h3>What to hold on to</h3>');
  blocks.push(`<ul>\n${lesson.points.map((point) => `  <li>${point}</li>`).join('\n')}\n</ul>`);
  blocks.push(`<p><strong>Check yourself.</strong> ${escapeHtml(lesson.check)}</p>`);

  return blocks.join('\n');
}

/** A lesson summary from its opening: one sentence, no markup, within 400 chars. */
function composeSummary(lesson, html) {
  if (lesson.summary) return lesson.summary;

  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stop = text.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? text : text.slice(0, stop + 1);

  return sentence.length <= 400 ? sentence : `${sentence.slice(0, 397).trimEnd()}…`;
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lesson HTML as something a person can read in a terminal, keeping the shape:
 * headings stay headings, lists stay lists, paragraphs stay paragraphs. Inline
 * tags are removed without leaving a gap, because `<em>period</em>.` must not
 * come out as "period .".
 */
function toPlainText(html) {
  return html
    .replace(/<\/?(?:em|strong|b|i|u|span|code|a|small|sup|sub|mark)(?:\s[^>]*)?>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, '\n\n## ')
    .replace(/<\/(?:h[1-6]|p|blockquote|ul|ol|div)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n  - ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plural(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

function wordCount(html) {
  const text = stripTags(html);
  return text ? text.split(' ').length : 0;
}

/** Everything the dry-run needs about one course, without touching the database. */
function prepare(course) {
  const lessons = [];

  course.modules.forEach((module, moduleIndex) => {
    module.lessons.forEach((lesson) => {
      const html = composeHtml(lesson);
      lessons.push({
        title: lesson.title || `${module.title} · ${moduleIndex + 1}`,
        module: module.title,
        summary: composeSummary(lesson, html),
        html,
        words: wordCount(html),
        minutes: lesson.minutes || DEFAULT_MINUTES,
      });
    });
  });

  /**
   * No lesson is marked as a preview here, deliberately.
   *
   * Making a lesson readable without enrolling is a decision about access, and
   * access belongs to the instructor who wrote the course: they tick "Free
   * preview — anyone can open this lesson without paying" on the lesson they want
   * to give away, or they give away nothing. Marking lesson one on their behalf
   * would hand out content they had not chosen to publish freely.
   */
  const words = lessons.reduce((total, lesson) => total + lesson.words, 0);

  return {
    slug: course.slug,
    title: course.title,
    program: course.program,
    type: course.__entry.type,
    category: course.category,
    level: course.level,
    credential: course.credential,
    priceCents: course.priceCents,
    certificateFeeCents: course.certificateFeeCents,
    file: course.__file,
    summary: course.summary,
    description: course.description,
    tags: course.tags,
    outcomes: course.outcomes,
    caseStudy: course.caseStudy || '',
    modules: course.modules.length,
    lessons,
    quiz: course.quiz.map((question, index) => ({
      prompt: question.prompt,
      kind: question.kind === 'true_false' ? 'true_false' : 'single',
      explanation: question.explanation || '',
      order: index + 1,
      options: question.options.map((option) => ({ text: option.text, isCorrect: option.correct === true })),
    })),
    words,
    wordsPerLesson: lessons.length ? Math.round(words / lessons.length) : 0,
    minutes: lessons.reduce((total, lesson) => total + lesson.minutes, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function money(cents) {
  if (cents === 0) return '$0';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padStart(value, width) {
  return String(value).padStart(width);
}

function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length))
  );

  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd();
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');

  return [line(headers), rule, ...rows.map(line)].join('\n');
}

function printCourseTable(courses) {
  const rows = courses.map((course, index) => [
    String(index + 1),
    course.title,
    course.category,
    course.level,
    money(course.priceCents),
    money(course.certificateFeeCents),
    String(course.modules),
    String(course.lessons.length),
    String(course.words),
    course.type,
  ]);

  return table(rows, ['#', 'Title', 'Category', 'Level', 'Price', 'Cert fee', 'Modules', 'Lessons', 'Words', 'Type']);
}

function programBlock(letter, prepared) {
  if (prepared.length === 0) return '';

  const lessons = prepared.reduce((total, course) => total + course.lessons.length, 0);
  const words = prepared.reduce((total, course) => total + course.words, 0);
  const prices = prepared.map((course) => course.priceCents).filter((cents) => cents > 0);

  const lines = [`${letter} (${plural(prepared.length, 'course')})`, '', printCourseTable(prepared), ''];

  lines.push(
    `  ${plural(prepared.length, 'course')} · ${plural(lessons, 'lesson')} · ${words.toLocaleString('en-US')} words` +
      (prices.length
        ? ` · average price ${money(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length))}`
        : ' · free to enrol')
  );

  return lines.join('\n');
}

function sampleBlock(label, course) {
  const lesson = course.lessons[0];
  if (!lesson) return '';

  return [
    `Sample ${label} — ${course.title} (${course.type}, ${course.lessons.length} lessons)`,
    '='.repeat(76),
    '',
    `Lesson 1 of ${course.lessons.length} · ${lesson.module}`,
    `Title: ${lesson.title}`,
    `Words: ${lesson.words} · Minutes: ${lesson.minutes}`,
    '',
    toPlainText(lesson.html),
    '',
    '--- quiz (first question) ---',
    course.quiz[0].prompt,
    ...course.quiz[0].options.map((option) => `  [${option.isCorrect ? 'x' : ' '}] ${option.text}`),
    course.quiz[0].explanation ? `  Why: ${course.quiz[0].explanation}` : '',
    '',
  ].join('\n');
}

function revenue(prepared) {
  const byProgram = (program) => prepared.filter((course) => course.program === program);

  const fcp = byProgram('FCP');
  const cpp = byProgram('CPP');
  const pdp = byProgram('PDP');

  const fcpFees = fcp.filter((course) => course.certificateFeeCents > 0);
  const fcpFree = fcp.filter((course) => course.certificateFeeCents === 0);
  const average = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0);

  const fcpAverage = average(fcpFees.map((course) => course.certificateFeeCents));
  const cppAverage = average(cpp.map((course) => course.priceCents));
  const pdpAverage = average(pdp.map((course) => course.priceCents));

  // One hundred learners, each finishing every course in a programme and
  // claiming each credential, is the clearest way to make the tiers comparable.
  const fcpAll = fcpFees.reduce((total, course) => total + course.certificateFeeCents, 0);
  const cppAll = cpp.reduce((total, course) => total + course.priceCents, 0);
  const pdpAll = pdp.reduce((total, course) => total + course.priceCents, 0);

  return [
    'Revenue if 100 learners each complete every course in a programme:',
    '',
    `  FCP  ${plural(fcp.length, 'course')}, free to enrol`,
    `       ${fcpFree.length} issue a certificate at no charge · ${fcpFees.length} charge a certificate fee`,
    `       ${money(fcpAverage)} average fee · ${money(fcpAll)} per learner if every fee is paid · ${money(fcpAll * 100)} per 100 learners`,
    `  CPP  ${plural(cpp.length, 'course')} at ${money(cppAverage)} average · ${money(cppAll)} per learner · ${money(cppAll * 100)} per 100 learners`,
    `  PDP  ${plural(pdp.length, 'course')} at ${money(pdpAverage)} average · ${money(pdpAll)} per learner · ${money(pdpAll * 100)} per 100 learners`,
    '',
    '  The FCP figure is a ceiling, not a forecast: nobody pays it unless they',
    '  choose to claim the certificate. The enrolment itself is free.',
  ].join('\n');
}

function report(prepared, { manifest, filtered }) {
  const out = [];

  out.push('');
  out.push('Phase 2d — catalog dry run');
  out.push('==========================');
  out.push('');
  out.push(`  outline index  ${path.relative(path.join(__dirname, '..'), MANIFEST_PATH)}`);
  out.push(`  instructor     ${manifest.instructorEmail}`);
  out.push(`  courses        ${prepared.length}${filtered ? ' (filtered)' : ''}`);
  out.push('');
  out.push('Nothing is written. This is a report over data/courses/*.json.');
  out.push('');

  for (const program of ['FCP', 'CPP', 'PDP']) {
    const block = programBlock(program, prepared.filter((course) => course.program === program));
    if (block) out.push(block, '');
  }

  const lessons = prepared.reduce((total, course) => total + course.lessons.length, 0);
  const words = prepared.reduce((total, course) => total + course.words, 0);
  const questions = prepared.reduce((total, course) => total + course.quiz.length, 0);
  const handwritten = prepared.filter((course) => course.type === 'handwritten');
  const templated = prepared.filter((course) => course.type === 'templated');
  const shortest = [...prepared].sort((a, b) => a.words - b.words)[0];
  const longest = [...prepared].sort((a, b) => b.words - a.words)[0];

  out.push('Totals');
  out.push('------');
  out.push(`  courses            ${prepared.length}`);
  out.push(`  handwritten        ${handwritten.length}`);
  out.push(`  templated          ${templated.length}`);
  out.push(`  lessons            ${lessons}`);
  out.push(`  words              ${words.toLocaleString('en-US')}`);
  out.push(`  words per course   ${Math.round(words / prepared.length).toLocaleString('en-US')} average · ${shortest.words.toLocaleString('en-US')} shortest (${shortest.title}) · ${longest.words.toLocaleString('en-US')} longest (${longest.title})`);
  out.push(`  quizzes            ${prepared.length}`);
  out.push(`  quiz questions     ${questions}`);
  out.push('');

  out.push('Handwritten');
  out.push('-----------');
  for (const course of handwritten) {
    out.push(`  ${course.program}  ${pad(course.title, 46)} ${padStart(course.lessons.length, 2)} lessons · ${course.words.toLocaleString('en-US')} words`);
  }
  out.push('');

  out.push(revenue(prepared), '');

  out.push('Sample lessons');
  out.push('--------------');
  out.push('');

  const pick = (slug) => prepared.find((course) => course.slug === slug);
  const samples = [
    ['1 (FCP)', pick('financial-management')],
    ['2 (CPP)', pick('advanced-financial-analysis-and-modeling')],
    ['3 (PDP)', pick('executive-leadership-and-management-diploma')],
  ].filter(([, course]) => course);

  for (const [label, course] of samples) {
    out.push(sampleBlock(label, course));
  }

  if (samples.length < 3) {
    out.push(`  Only ${samples.length} of the three sample courses are present.`);
    out.push('');
  }

  out.push('Dry run only. Nothing was written to the database.');
  out.push('');

  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Commit
 * ------------------------------------------------------------------ */

async function commit(prepared, { publish, force }) {
  const db = require('../src/db');
  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');
  const Quiz = require('../src/models/Quiz');
  const User = require('../src/models/User');
  const Enrollment = require('../src/models/Enrollment');
  const { sanitizeLessonHtml } = require('../src/lib/sanitizeHtml');

  await db.connect();

  const instructor = await User.findOne({ email: 'motivacooperation4@gmail.com' });
  if (!instructor) throw new Error('the instructor account does not exist on this database');

  const written = [];

  for (const course of prepared) {
    let document = await Course.findOne({ slug: course.slug });
    const created = !document;

    if (document) {
      const started = await Enrollment.countDocuments({ course: document._id, 'completedLessons.0': { $exists: true } });
      if (started > 0 && !force) {
        throw new Error(
          `${course.slug}: ${started} enrolment(s) already have completed lessons. Replacing the lessons ` +
            'would reset their progress. Re-run with --force if that is what you want.'
        );
      }
    } else {
      document = new Course({ slug: course.slug });
    }

    document.title = course.title;
    document.summary = course.summary;
    document.description = course.description;
    document.category = course.category;
    document.level = course.level;
    document.credential = course.credential;
    document.tags = course.tags;
    document.priceCents = course.priceCents;
    document.certificateFeeCents = course.certificateFeeCents;
    document.instructor = instructor._id;
    document.instructorName = instructor.fullName;

    const removedLessons = await Lesson.deleteMany({ course: document._id });
    const removedQuizzes = await Quiz.deleteMany({ course: document._id });

    const created_lessons = [];

    for (const [index, lesson] of course.lessons.entries()) {
      const body = sanitizeLessonHtml(lesson.html);
      if (!body) throw new Error(`${course.slug}: lesson ${index + 1} sanitised to nothing`);

      created_lessons.push(
        await Lesson.create({
          course: document._id,
          title: lesson.title,
          summary: lesson.summary,
          type: 'text',
          content: body,
          order: index + 1,
          durationMinutes: lesson.minutes,
          published: true,
        })
      );
    }

    const last = created_lessons[created_lessons.length - 1];

    await Quiz.create({
      lesson: last._id,
      course: document._id,
      title: 'Final assessment',
      passPercent: 70,
      maxAttempts: 0,
      questions: course.quiz,
    });

    const publishedLessons = await Lesson.find({ course: document._id, published: true }).select('durationMinutes');
    document.lessonCount = publishedLessons.length;
    document.durationHours =
      Math.round((publishedLessons.reduce((sum, item) => sum + (item.durationMinutes || 0), 0) / 60) * 10) / 10;

    if (publish) {
      document.status = 'published';
      document.publishedAt = document.publishedAt || new Date();
    }

    await document.save();

    written.push({
      slug: course.slug,
      created,
      lessons: created_lessons.length,
      removedLessons: removedLessons.deletedCount,
      removedQuizzes: removedQuizzes.deletedCount,
      status: document.status,
      words: course.words,
    });
  }

  await db.disconnect();
  return written;
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

function argValue(name) {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const manifest = loadManifest();

  const onlyCourse = argValue('course');
  const onlyProgram = argValue('program');
  const shouldCommit = process.argv.includes('--commit');
  const publish = process.argv.includes('--publish');
  const force = process.argv.includes('--force');

  const entries = manifest.courses.filter((entry) => {
    if (onlyCourse && entry.slug !== onlyCourse) return false;
    if (onlyProgram && entry.program !== onlyProgram) return false;
    return true;
  });

  if (entries.length === 0) throw new Error(`no course matches ${onlyCourse || onlyProgram}`);

  const prepared = [];
  const problems = [];

  for (const entry of entries) {
    try {
      const course = loadCourse(manifest, entry);
      validateCourse(course);
      prepared.push(prepare(course));
    } catch (error) {
      problems.push(error.message);
      process.stderr.write(`  problem: ${error.message}\n`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`\n${problems.length} course(s) failed validation. Nothing was written.\n`);
    process.exitCode = 1;
    return;
  }

  const filtered = Boolean(onlyCourse || onlyProgram);

  if (!shouldCommit) {
    process.stdout.write(report(prepared, { manifest, filtered }));
    return;
  }

  const written = await commit(prepared, { publish, force });

  process.stdout.write(
    [
      '',
      `Wrote ${written.length} course(s)${publish ? ', published' : ' as drafts'}.`,
      '',
      ...written.map(
        (item) =>
          `  ${item.created ? 'created' : 'updated'}  ${pad(item.slug, 50)} ${item.lessons} lessons · ` +
          `${item.words.toLocaleString('en-US')} words · ${item.status}` +
          (item.removedLessons ? ` (replaced ${item.removedLessons} lessons, ${item.removedQuizzes} quizzes)` : '')
      ),
      '',
    ].join('\n')
  );
}

main().catch((error) => {
  process.stderr.write(`\ncourses: ${error.message}\n`);
  process.exitCode = 1;
});
