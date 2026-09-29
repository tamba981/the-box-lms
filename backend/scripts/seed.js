'use strict';

/**
 * Demo data.
 *
 *   npm run seed              # create anything that is missing
 *   npm run seed -- --fresh   # remove the demo content first, then recreate it
 *
 * Refuses to run against a production database unless forced, because it
 * creates accounts with published passwords.
 *
 * Every account it makes is idempotent: seeding twice updates the existing
 * record rather than failing on the unique email index.
 */

const config = require('../src/config/env');
const db = require('../src/db');
const logger = require('../src/lib/logger');

const Certificate = require('../src/models/Certificate');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Lesson = require('../src/models/Lesson');
const LiveSession = require('../src/models/LiveSession');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');

const { slugify } = require('../src/lib/slug');

const FRESH = process.argv.includes('--fresh');

/** Override with SEED_PASSWORD=… to avoid the published demo passwords. */
const PASSWORD = process.env.SEED_PASSWORD || 'WuteveDemo12345';

const ACCOUNTS = [
  {
    firstName: 'Amina',
    lastName: 'Kamara',
    email: 'admin@wuteve.edu',
    role: 'admin',
    headline: 'Registrar, Wuteve Global Academy',
  },
  {
    firstName: 'Isaac',
    lastName: 'Mensah',
    email: 'instructor@wuteve.edu',
    role: 'instructor',
    headline: 'Data analyst and lecturer',
    expertise: ['Data analysis', 'Statistics', 'Spreadsheets'],
    bio: 'Twelve years teaching quantitative methods to first-generation university students.',
  },
  {
    firstName: 'Grace',
    lastName: 'Osei',
    email: 'instructor2@wuteve.edu',
    role: 'instructor',
    headline: 'Software engineer and trainer',
    expertise: ['JavaScript', 'Web development'],
    bio: 'Builds web applications and teaches the fundamentals properly.',
  },
  {
    firstName: 'Samuel',
    lastName: 'Toe',
    email: 'student@wuteve.edu',
    role: 'student',
  },
];

const COURSES = [
  {
    title: 'Introduction to Data Analysis',
    instructor: 'instructor@wuteve.edu',
    category: 'data',
    level: 'beginner',
    priceCents: 0,
    summary: 'Turn raw numbers into decisions, starting from nothing.',
    description:
      'A practical first course in data analysis. You will learn how to clean a messy dataset, describe what it contains, and present a finding that somebody can act on.\n\nNo prior statistics is assumed. Every technique is introduced with a worked example you can follow along with.',
    lessons: [
      { title: 'What data analysis actually is', minutes: 35, isPreview: true, type: 'text',
        content: 'Data analysis is the work of turning a pile of records into a decision.\n\nIn this lesson we look at three questions a good analysis answers: what happened, why it happened, and what to do next. We also look at two examples where a technically correct analysis led to a bad decision, and what was missing.' },
      { title: 'Reading a dataset before you touch it', minutes: 45, type: 'video',
        content: 'Before you calculate anything, you need to know what you are holding: how many rows, which columns, what is missing, and what the units are.' },
      { title: 'Cleaning without destroying the evidence', minutes: 50, type: 'text',
        content: 'Cleaning is where most analyses go wrong. We cover duplicates, inconsistent categories, impossible values and missing data — and why you should record every change you make.' },
      { title: 'Describing a dataset in five numbers', minutes: 40, type: 'video',
        content: 'Mean, median, range, and the two numbers that tell you how spread out the data is.' },
      { title: 'Presenting a finding', minutes: 55, type: 'text',
        content: 'A finding nobody understands has no value. We build one page that states the question, the answer, the uncertainty, and the recommendation.' },
    ],
  },
  {
    title: 'Spreadsheets for Real Work',
    instructor: 'instructor@wuteve.edu',
    category: 'productivity',
    level: 'beginner',
    priceCents: 0,
    summary: 'The spreadsheet skills employers actually ask for.',
    description:
      'Most people use a spreadsheet as a table. This course teaches it as a tool: lookups, pivot tables, conditional logic and the handful of functions that do most of the work in practice.',
    lessons: [
      { title: 'Structuring a sheet so it can grow', minutes: 30, isPreview: true, type: 'text',
        content: 'One row per record, one column per field, no merged cells in the data. These three rules prevent most of the problems that make a spreadsheet unmaintainable.' },
      { title: 'Lookups that do not break', minutes: 45, type: 'video',
        content: 'VLOOKUP, INDEX/MATCH and XLOOKUP, and when each is the right choice.' },
      { title: 'Pivot tables from first principles', minutes: 50, type: 'video',
        content: 'Grouping, aggregating and comparing — without writing a single formula.' },
      { title: 'Conditional logic and validation', minutes: 40, type: 'text',
        content: 'IF, COUNTIF and data validation, used to make a sheet that rejects bad input.' },
    ],
  },
  {
    title: 'Web Development Foundations',
    instructor: 'instructor2@wuteve.edu',
    category: 'technology',
    level: 'beginner',
    priceCents: 1999,
    summary: 'HTML, CSS and JavaScript — the honest introduction.',
    description:
      'Build real pages from the first lesson. We cover the browser, the document, styling, and enough JavaScript to make a page respond to a person.\n\nBy the end you will have published a small site of your own.',
    lessons: [
      { title: 'How a web page reaches a screen', minutes: 30, isPreview: true, type: 'text',
        content: 'A request, a response, and a browser that turns text into a page. Understanding this loop makes every later lesson easier.' },
      { title: 'Semantic HTML', minutes: 45, type: 'video',
        content: 'Choosing the right element is accessibility, search visibility and maintainability in one decision.' },
      { title: 'CSS layout: flexbox and grid', minutes: 60, type: 'video',
        content: 'Two layout systems cover almost everything. We build the same page in both and compare.' },
      { title: 'JavaScript: values, decisions, repetition', minutes: 55, type: 'text',
        content: 'The parts of the language you need before you touch a framework.' },
      { title: 'Making a page respond', minutes: 50, type: 'video',
        content: 'Events, the document object model, and updating a page without reloading it.' },
      { title: 'Publishing your work', minutes: 35, type: 'text',
        content: 'Getting your site onto the internet so somebody other than you can open it.' },
    ],
  },
  {
    title: 'Project Management Essentials',
    instructor: 'instructor@wuteve.edu',
    category: 'business',
    level: 'intermediate',
    priceCents: 2499,
    summary: 'Scope, schedule and risk — delivered without jargon.',
    description:
      'A grounded introduction to running a project: how to define what is being delivered, how to plan it, and how to notice trouble early enough to do something about it.',
    lessons: [
      { title: 'Defining the deliverable', minutes: 40, isPreview: true, type: 'text',
        content: 'A project without a defined deliverable cannot be finished, only abandoned.' },
      { title: 'Planning what you can control', minutes: 50, type: 'video',
        content: 'Estimating, sequencing and the assumption that everything will take longer than you think.' },
      { title: 'Risk registers that get used', minutes: 45, type: 'text',
        content: 'A risk register nobody reads is theatre. We build one that changes decisions.' },
      { title: 'Status reporting honestly', minutes: 40, type: 'video',
        content: 'How to report a project that is going badly, in a way that produces help rather than blame.' },
    ],
  },
  {
    title: 'Financial Literacy for Professionals',
    instructor: 'instructor@wuteve.edu',
    category: 'business',
    level: 'beginner',
    priceCents: 1499,
    summary: 'Budgeting, saving and the time value of money.',
    description:
      'The financial knowledge that is assumed of every professional but rarely taught: reading a payslip, building a budget that survives a bad month, and understanding what interest does to you in both directions.',
    lessons: [
      { title: 'Where your money goes', minutes: 35, isPreview: true, type: 'text',
        content: 'A budget is a description of your priorities, not a punishment. We build one from real numbers.' },
      { title: 'The time value of money', minutes: 45, type: 'video',
        content: 'Why a sum today is worth more than the same sum later, and how to compare two offers fairly.' },
      { title: 'Debt: cost, order and escape', minutes: 45, type: 'text',
        content: 'Interest rates, repayment order, and the arithmetic of getting out.' },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function upsertAccount(spec) {
  const existing = await User.findOne({ email: spec.email });

  if (existing) {
    // Keep the role and profile current so re-seeding repairs a half-set-up
    // database rather than skipping it.
    existing.firstName = spec.firstName;
    existing.lastName = spec.lastName;
    existing.role = spec.role;
    existing.status = 'active';
    existing.emailVerified = true;
    existing.emailVerifiedAt = existing.emailVerifiedAt || new Date();
    if (spec.headline) existing.headline = spec.headline;
    if (spec.bio) existing.bio = spec.bio;
    if (spec.expertise) existing.expertise = spec.expertise;

    await existing.save();
    return { user: existing, created: false };
  }

  const user = await User.create({
    ...spec,
    password: PASSWORD,
    emailVerified: true,
    emailVerifiedAt: new Date(),
  });

  return { user, created: true };
}

async function upsertCourse(spec, instructorByEmail) {
  const slug = slugify(spec.title);
  const instructor = instructorByEmail.get(spec.instructor);

  if (!instructor) throw new Error(`No instructor for "${spec.title}" (${spec.instructor})`);

  let course = await Course.findOne({ slug });

  const fields = {
    title: spec.title,
    summary: spec.summary,
    description: spec.description,
    category: spec.category,
    level: spec.level,
    priceCents: spec.priceCents,
    currency: 'usd',
    instructor: instructor._id,
    instructorName: instructor.fullName,
    status: 'published',
    publishedAt: new Date(),
  };

  if (!course) {
    course = await Course.create({ ...fields, slug });
  } else {
    Object.assign(course, fields);
    await course.save();
  }

  // Lessons are replaced wholesale: this keeps the syllabus identical to the
  // definition above instead of accumulating stale rows across edits.
  await Lesson.deleteMany({ course: course._id });

  let order = 1;
  const totalMinutes = spec.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);

  for (const lesson of spec.lessons) {
    await Lesson.create({
      course: course._id,
      title: lesson.title,
      summary: lesson.summary || '',
      type: lesson.type,
      content: lesson.content,
      order,
      durationMinutes: lesson.minutes,
      isPreview: Boolean(lesson.isPreview),
      published: true,
    });

    order += 1;
  }

  course.lessonCount = spec.lessons.length;
  course.durationHours = Math.round((totalMinutes / 60) * 10) / 10;
  await course.save();

  return course;
}

async function removeExistingDemoData() {
  const emails = ACCOUNTS.map((account) => account.email);
  const users = await User.find({ email: { $in: emails } }).select('_id');
  const userIds = users.map((user) => user._id);

  const courses = await Course.find({
    $or: [{ instructor: { $in: userIds } }, { slug: { $in: COURSES.map((course) => slugify(course.title)) } }],
  }).select('_id');

  const courseIds = courses.map((course) => course._id);

  await Certificate.deleteMany({ $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }] });
  await Notification.deleteMany({ user: { $in: userIds } });
  await LiveSession.deleteMany({ $or: [{ instructor: { $in: userIds } }, { course: { $in: courseIds } }] });
  await Enrollment.deleteMany({ $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }] });
  await Lesson.deleteMany({ course: { $in: courseIds } });
  await Course.deleteMany({ _id: { $in: courseIds } });

  return { courses: courseIds.length, users: userIds.length };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  if (config.isProduction && !process.argv.includes('--force')) {
    process.stderr.write(
      '\nRefusing to seed a production database.\n\n' +
        'This creates accounts with published demo passwords. If you genuinely mean to do this,\n' +
        'run it with --force and set SEED_PASSWORD to something private:\n\n' +
        '  SEED_PASSWORD="…" npm run seed -- --force\n\n'
    );
    process.exit(1);
  }

  await db.connect();

  process.stdout.write(`\nSeeding ${config.env} database\n${'-'.repeat(40)}\n\n`);

  if (FRESH) {
    const removed = await removeExistingDemoData();
    process.stdout.write(`Removed ${removed.courses} demo courses and ${removed.users} demo accounts.\n\n`);
  }

  const instructorByEmail = new Map();
  const created = { users: 0, updated: 0 };

  for (const spec of ACCOUNTS) {
    // eslint-disable-next-line no-await-in-loop
    const { user, created: isNew } = await upsertAccount(spec);

    if (spec.role === 'instructor') instructorByEmail.set(spec.email, user);

    if (isNew) created.users += 1;
    else created.updated += 1;
  }

  process.stdout.write(`Accounts: ${created.users} created, ${created.updated} updated.\n`);

  let courseCount = 0;

  for (const spec of COURSES) {
    // eslint-disable-next-line no-await-in-loop
    const course = await upsertCourse(spec, instructorByEmail);
    courseCount += 1;
    process.stdout.write(`  · ${course.title} (${course.priceLabel}, ${course.lessonCount} lessons)\n`);
  }

  // One live session in the future, so the dashboard widget has something real
  // to show rather than an empty panel.
  const sampleCourse = await Course.findOne({ slug: slugify(COURSES[0].title) });
  const student = await User.findOne({ email: 'student@wuteve.edu' });

  if (sampleCourse) {
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    start.setHours(16, 0, 0, 0);

    const end = new Date(start.getTime() + 90 * 60 * 1000);

    await LiveSession.deleteMany({ course: sampleCourse._id, title: 'Live Q&A: your first analysis' });

    await LiveSession.create({
      course: sampleCourse._id,
      courseTitle: sampleCourse.title,
      title: 'Live Q&A: your first analysis',
      description: 'Bring the dataset you have been working on and we will go through it together.',
      instructor: sampleCourse.instructor,
      instructorName: sampleCourse.instructorName,
      startTime: start,
      endTime: end,
      meetingLink: 'https://meet.example.com/wuteve-qa',
      status: 'scheduled',
    });

    process.stdout.write(`\nScheduled a live session on ${start.toUTCString()}.\n`);
  }

  process.stdout.write(`\n${'-'.repeat(40)}\n`);
  process.stdout.write(`${courseCount} courses published.\n\n`);
  process.stdout.write('Sign in with:\n');
  process.stdout.write(`  admin@wuteve.edu        / ${PASSWORD}\n`);
  process.stdout.write(`  instructor@wuteve.edu   / ${PASSWORD}\n`);
  process.stdout.write(`  student@wuteve.edu      / ${PASSWORD}\n\n`);

  if (!process.env.SEED_PASSWORD) {
    process.stdout.write(
      'These passwords are published in the seed script. Change them before this database is\n' +
        'reachable by anyone else, or re-run with SEED_PASSWORD set.\n\n'
    );
  }

  logger.debug('seed complete', { courses: courseCount, users: created.users + created.updated });

  await db.disconnect();
}

main().catch(async (error) => {
  process.stderr.write(`\nSeeding failed: ${error.stack}\n`);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
