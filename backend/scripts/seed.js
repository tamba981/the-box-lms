'use strict';

/**
 * Demo data.
 *
 *   npm run seed              # create anything that is missing
 *   npm run seed -- --fresh   # remove the demo content first, then recreate it
 *
 * Refuses to run against a production database unless forced. It no longer
 * creates accounts with published passwords: with no SEED_PASSWORD set it
 * generates one for the run and prints it once.
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
const { generatePassword } = require('../src/lib/generatePassword');

const FRESH = process.argv.includes('--fresh');

/**
 * The password every seeded account is given.
 *
 * There is deliberately no fallback. This used to default to a fixed string that
 * was also written in the README, so seeding any database a person could reach
 * handed out three working logins to whoever read the repository. Warning about
 * it afterwards was not enough — the accounts existed either way, and the seed
 * was run against production at least once.
 *
 * With SEED_PASSWORD unset a random one is generated, used, and printed once at
 * the end of the run. Nothing stores it, so saving it is the operator's job, and
 * losing it costs only another seed run.
 */
const GENERATED_PASSWORD = process.env.SEED_PASSWORD ? null : generatePassword();

const PASSWORD = process.env.SEED_PASSWORD || GENERATED_PASSWORD;

const ACCOUNTS = [
  {
    firstName: 'Amina',
    lastName: 'Kamara',
    email: 'admin@wuteve.edu',
    role: 'admin',
    headline: 'Registrar, Wuteve Global Academy',
  },
  /**
   * A second administrator, on the domain the academy actually owns.
   *
   * `wuteve.edu` is not ours, so a password-reset link sent to the account above
   * goes to an address nobody can read — and with no transactional email
   * configured, that link would not be sent at all. Keeping an administrator on
   * `wuteveglobalacademy.com` means recovery is possible the day Resend is
   * switched on, without leaving the deployment without a way in until then.
   *
   * Note on re-seeding: `upsertAccount` only assigns the seed password when it
   * creates an account. On an account that already exists it refreshes the role
   * and profile and leaves the password alone, so running the seed again will
   * not overwrite the password issued by `scripts/create-admin.js`. Running it
   * with `--fresh` deletes and recreates everything, password included.
   */
  {
    firstName: 'Academy',
    lastName: 'Administrator',
    email: 'admin@wuteveglobalacademy.com',
    role: 'admin',
    headline: 'Wuteve Global Academy',
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
        'This creates instructor and admin accounts. If you genuinely mean to do this,\n' +
        'run it with --force:\n\n' +
        '  npm run seed -- --force\n\n' +
        'Set SEED_PASSWORD to choose their password; otherwise one is generated and\n' +
        'printed once at the end.\n\n'
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
  process.stdout.write('  admin@wuteve.edu\n');
  process.stdout.write('  instructor@wuteve.edu\n');
  process.stdout.write('  student@wuteve.edu\n\n');

  /**
   * Only accounts created by this run were given this password, and saying
   * otherwise would send somebody to a sign-in form with a password that does
   * not work. The distinction is not cosmetic: on a database that has already
   * been seeded, every account is "updated", and the password printed here would
   * have been a lie.
   */
  if (created.users > 0) {
    process.stdout.write(
      `The ${created.users} account${created.users === 1 ? '' : 's'} created just now can sign in with:\n\n` +
        `  ${PASSWORD}\n\n`
    );

    if (GENERATED_PASSWORD) {
      process.stdout.write(
        'That password was generated for this run and is stored nowhere. Save it now — it is\n' +
          'shown here only. Set SEED_PASSWORD to choose your own instead.\n\n'
      );
    }
  }

  if (created.updated > 0) {
    process.stdout.write(
      `${created.updated} account${created.updated === 1 ? '' : 's'} already existed and kept their existing\n` +
        'passwords, because the seed only sets one when it creates an account. Change one with\n' +
        'POST /api/v1/auth/change-password, or re-run with --fresh to recreate them.\n\n'
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
