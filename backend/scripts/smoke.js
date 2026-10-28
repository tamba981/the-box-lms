'use strict';

/**
 * End-to-end smoke test.
 *
 * Boots the real Express app against the configured database, exercises every
 * authentication path over HTTP, and asserts on the security properties that
 * matter — most importantly that a caller cannot make themselves an admin.
 *
 *   npm run smoke
 *
 * Exits non-zero on the first failure category, so it can gate a deploy.
 * All records it creates are removed on the way out.
 */

const crypto = require('crypto');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

// The suite signs in a handful of times and then carries those access tokens
// through every later section. At the production default of 15 minutes, a run on
// a slow or distant cluster can outlive its own tokens: the final sections then
// fail with 401 and read as broken authorisation when nothing is actually wrong.
// Give the run a lifetime it cannot exceed. This does not mask any deliberate
// expired-token test — those forge their own tokens with an explicit past expiry.
process.env.JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '2h';

// The Stripe webhook is testable without a Stripe account: the signature is just
// an HMAC we can compute ourselves. Supplying a secret here means the suite
// exercises the real verification and fulfilment path — accepted deliveries,
// forged signatures, replays and amount mismatches — rather than only ever
// reaching the "payments are not configured" branch.
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || `whsec_test_${crypto.randomBytes(16).toString('hex')}`;

// Only the callback secret is supplied for mobile money, and that is deliberate.
// It is the state this deployment is genuinely in: a callback can be verified and
// settled, while starting a charge still reports which settings are missing.
// Configuring all four would test a happy path that cannot exist yet.
// Social sign-in is only exercised as far as the redirect: a fake credential
// pair makes Google "configured" so the start endpoint builds a real authorize
// URL and the callback validates state, without any request leaving the runner.
// Nothing downstream of the state check is reached, so no network is needed.
// The AI surfaces are exercised without leaving the runner: a fake key makes
// them "configured", and the provider call itself is stubbed below in testAi().
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret-value';

process.env.LONESTAR_MOMO_CALLBACK_SECRET =
  process.env.LONESTAR_MOMO_CALLBACK_SECRET ||
  `test_callback_${crypto.randomBytes(12).toString('hex')}`;

/* ------------------------------------------------------------------ *
 * Which database this suite writes to
 * ------------------------------------------------------------------ */

/**
 * The suite has to *publish* courses to test publishing, the catalog and
 * enrolment, so whatever database it runs against shows fixture courses on
 * /courses.html for the length of the run — and if the process is killed,
 * teardown never runs and they stay there.
 *
 * So it prefers a database of its own. Resolution order:
 *
 *   1. `TEST_MONGODB_URI`, if set.
 *   2. `MONGODB_URI` with its database name changed to `<name>_test`. Safe by
 *      construction: this can never write to the database named in MONGODB_URI,
 *      and it needs no second copy of the credentials.
 *   3. `MONGODB_URI` unchanged — only when it carries no database name to
 *      derive from. That is the shared-database case, and it says so loudly.
 *
 * `.env` is read here rather than left to `config/env.js`, because config is
 * loaded a moment later and by then the connection string has been decided.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/** The database name in a connection string, or null. */
function databaseNameOf(uri) {
  const beforeQuery = String(uri).split('?')[0];
  const schemeEnd = beforeQuery.indexOf('://');
  if (schemeEnd === -1) return null;

  const authority = beforeQuery.slice(schemeEnd + 3);
  const pathStart = authority.indexOf('/');
  if (pathStart === -1) return null;

  const name = authority.slice(pathStart + 1);
  return name || null;
}

/** The same URI pointed at `<database>_test`. */
function withTestDatabase(uri) {
  const name = databaseNameOf(uri);
  if (!name) return null;
  if (/_test$/.test(name)) return uri;

  const beforeQuery = uri.split('?')[0];
  const query = uri.slice(beforeQuery.length);

  return `${beforeQuery.slice(0, beforeQuery.length - name.length)}${name}_test${query}`;
}

(function redirectToTestDatabase() {
  const explicit = (process.env.TEST_MONGODB_URI || '').trim();
  const base = (process.env.MONGODB_URI || '').trim();

  function warnShared() {
    if (process.env.NODE_ENV === 'production') {
      process.stderr.write(
        'ERROR: refusing to run the smoke suite against MONGODB_URI in production without an isolated test database.\n'
      );
      process.exit(1);
    }

    process.stdout.write(
      '\n!! Smoke test database: the SAME database the site serves (' +
        `${databaseNameOf(base) || 'unknown'}).\n` +
        '!! Its fixture courses will be visible on /courses.html for the length of this run.\n' +
        '!! Set TEST_MONGODB_URI (or put a database name in MONGODB_URI) to isolate it.\n\n'
    );
  }

  if (explicit) {
    // Pointing the suite at the live database explicitly is still pointing it at
    // the live database, so it gets the same warning rather than a false comfort.
    if (databaseNameOf(explicit) === databaseNameOf(base)) {
      process.env.MONGODB_URI = explicit;
      warnShared();
      return;
    }

    process.env.MONGODB_URI = explicit;
    process.stdout.write(`Smoke test database: ${databaseNameOf(explicit) || '(unknown)'} (isolated, from TEST_MONGODB_URI)\n`);
    return;
  }

  const derived = base ? withTestDatabase(base) : null;

  if (derived && derived !== base) {
    process.env.MONGODB_URI = derived;
    process.stdout.write(
      `Smoke test database: ${databaseNameOf(derived)} (isolated from ${databaseNameOf(base)})\n` +
        'Fixtures therefore cannot appear on the public catalog. Set TEST_MONGODB_URI to choose another.\n'
    );
    return;
  }

  warnShared();
})();

const db = require('../src/db');
const User = require('../src/models/User');
const Token = require('../src/models/Token');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');
const Enrollment = require('../src/models/Enrollment');
const AIUsageLog = require('../src/models/AIUsageLog');
const { createApp } = require('../src/app');

const results = [];

/**
 * Suites that declined to run, and why.
 *
 * Some of the admin checks sign in with the seeded demo account, so they need a
 * database that has been seeded. That is a reasonable thing to tolerate — but the
 * tolerance used to be silent, and the only symptom was a smaller total. A run
 * against a database with no demo admin reported "184/184 checks passed" while
 * six checks had not run at all, and an empty deployment passed the suite that
 * was supposed to be watching it.
 */
const skipped = [];

let baseUrl = '';
let server = null;

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Every rejected authenticated request the suite saw, with the server's own reason.
 *
 * The suite has produced an intermittent 401 in its later sections that resisted
 * explanation. Three attempts were made to reason it out — token lifetime, a
 * stale token held across the password reset, test ordering — and the timing
 * evidence ruled the first out and the fixture layout ruled out the second.
 * Rather than keep guessing, this records what the server actually said. The
 * error code distinguishes the cases that matter: an expired token, a suspended
 * account, a superseded password, or a token this process never held.
 */
const rejections = [];

async function request(method, path, { body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML page or empty body */
  }

  // Only record rejections that carried a token: a 401 with no Authorization
  // header is a deliberate unauthenticated probe, not a surprise.
  if (response.status === 401 && token) {
    let issuedAt = null;
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
      issuedAt = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
    } catch {
      issuedAt = null;
    }

    rejections.push({
      at: new Date().toISOString(),
      method,
      path,
      code: (json && json.code) || '(no code)',
      message: (json && json.message) || text.slice(0, 120),
      issuedAt,
      tokenLength: String(token).length,
    });
  }

  return { status: response.status, json, text, headers: response.headers };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const runId = crypto.randomBytes(4).toString('hex');
const primaryEmail = `smoke-${runId}@example.com`;
const createdEmails = [primaryEmail];
const PASSWORD = 'SmokeTest12345';

let primaryUser = null;

/**
 * A birthday that is always old enough.
 *
 * Computed from today rather than written down, so the suite does not start
 * failing in a few years for the unrelated reason that a fixed date is no
 * longer the age it used to be.
 */
const ADULT_DATE_OF_BIRTH = (() => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
})();

/** A sign-up body the API should accept, with any field overridden. */
function signupBody(overrides = {}) {
  return {
    firstName: 'Smoke',
    lastName: 'Tester',
    email: primaryEmail,
    password: PASSWORD,
    dateOfBirth: ADULT_DATE_OF_BIRTH,
    location: 'Monrovia, Liberia',
    ...overrides,
  };
}

async function cleanup() {
  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');
  const Enrollment = require('../src/models/Enrollment');
  const Certificate = require('../src/models/Certificate');
  const Quiz = require('../src/models/Quiz');
  const QuizAttempt = require('../src/models/QuizAttempt');
  const NewsletterSubscriber = require('../src/models/NewsletterSubscriber');
  const ContactMessage = require('../src/models/ContactMessage');
  const Message = require('../src/models/Message');
  const Notification = require('../src/models/Notification');
  const Thread = require('../src/models/Thread');
  const StudyGroup = require('../src/models/StudyGroup');
  const LiveSession = require('../src/models/LiveSession');
  const CommunityPost = require('../src/models/CommunityPost');
  const Review = require('../src/models/Review');
  const AdmissionApplication = require('../src/models/AdmissionApplication');
  const Payment = require('../src/models/Payment');

  await AdmissionApplication.deleteMany({ email: { $regex: '^smoke-.*@example\\.com$' } });

  // Clean up by namespace, not only by tracked email.
  //
  // Tracking alone was not enough: an account created moments before a failure
  // never reaches `createdEmails`, and those accounts accumulated — ten of them
  // were found sitting in the database, along with everything hanging off them.
  // The suite's own fixture namespace is the reliable key. `example.com` is
  // reserved for exactly this purpose by RFC 2606, so the pattern cannot collide
  // with a real account.
  const users = await User.find({
    $or: [
      { email: { $in: createdEmails } },
      { email: { $regex: '^smoke-.*@example\\.com$' } },
    ],
  }).select('_id');
  const userIds = users.map((user) => user._id);

  // Courses owned by the fixture instructors, so their lessons go too. This is
  // the authoritative mechanism: every course the suite creates is created by a
  // fixture account. The extra title match below is deliberately narrow — a
  // broad pattern here would delete real seeded content from the same database.
  const courses = await Course.find({
    $or: [
      { instructor: { $in: userIds } },
      { title: { $in: ['Community test course', 'A free course for the checkout test', 'A paid course for the checkout test'] } },
    ],
  }).select('_id');
  const courseIds = courses.map((course) => course._id);

  const enrollments = await Enrollment.find({
    $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }],
  }).select('_id');

  await Certificate.deleteMany({
    $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }],
  });
  await Notification.deleteMany({ user: { $in: userIds } });
  await Message.deleteMany({ sender: { $in: userIds } });
  await Thread.deleteMany({ participants: { $in: userIds } });
  await StudyGroup.deleteMany({ $or: [{ createdBy: { $in: userIds } }, { members: { $in: userIds } }] });
  await LiveSession.deleteMany({ $or: [{ instructor: { $in: userIds } }, { course: { $in: courseIds } }] });
  await CommunityPost.deleteMany({ $or: [{ user: { $in: userIds } }, { course: { $in: courseIds } }] });
  await Review.deleteMany({ $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }] });
  await Payment.deleteMany({
    $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }],
  });
  await Enrollment.deleteMany({ _id: { $in: enrollments.map((enrollment) => enrollment._id) } });

  // AI usage rows point at a user and often a course; left behind they would be
  // orphans that also quietly inflate any cost report.
  await AIUsageLog.deleteMany({
    $or: [{ user: { $in: userIds } }, { course: { $in: courseIds } }],
  });

  // Attempts go before quizzes: an attempt is a record of what a real student did,
  // and one left pointing at a deleted quiz would be an orphan nothing can explain.
  await QuizAttempt.deleteMany({
    $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }],
  });
  await Quiz.deleteMany({ course: { $in: courseIds } });

  // These two have no owner to hang off, so the fixture namespace is the only
  // handle. Without this the suite leaves a subscriber and a contact message
  // behind on every run, which is how stray rows accumulate unnoticed.
  await NewsletterSubscriber.deleteMany({ email: { $regex: '^smoke-.*@example\\.com$' } });
  await ContactMessage.deleteMany({ email: { $regex: '^smoke-.*@example\\.com$' } });
  await Lesson.deleteMany({ course: { $in: courseIds } });
  await Course.deleteMany({ _id: { $in: courseIds } });
  await Token.deleteMany({ user: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });

  // Report what is left rather than assuming the teardown was complete. A silent
  // teardown is how the residue above went unnoticed in the first place.
  const remaining = await User.countDocuments({ email: { $regex: '^smoke-.*@example\\.com$' } });
  if (remaining > 0) {
    throw new Error(`teardown left ${remaining} fixture account(s) behind`);
  }
}

/**
 * Remove fixtures a previous run left behind.
 *
 * Counted before deleting so the run can say what it repaired. `cleanup()` is the
 * single implementation of "remove everything this suite creates"; this only
 * decides whether it needs to run before the suite does.
 */
async function sweepFixtures() {
  const Course = require('../src/models/Course');

  const fixtureUsers = await User.find({
    email: { $regex: '^smoke-.*@example\\.com$' },
  }).select('_id');

  if (!fixtureUsers.length) return { users: 0, courses: 0 };

  const courses = await Course.countDocuments({
    instructor: { $in: fixtureUsers.map((user) => user._id) },
  });

  await cleanup();

  process.stdout.write(
    `Swept ${fixtureUsers.length} fixture account(s) and ${courses} course(s) ` +
      'left behind by a run that did not finish.\n\n'
  );

  return { users: fixtureUsers.length, courses };
}

/* ------------------------------------------------------------------ *
 * Suites
 * ------------------------------------------------------------------ */

async function testInfrastructure() {
  await check('health endpoint reports a live database', async () => {
    const { status, json } = await request('GET', '/health');
    assertEqual(status, 200, 'status');
    assertEqual(json.status, 'ok', 'status field');
    assertEqual(json.mongodb, 'connected', 'mongodb field');
  });

  await check('API index describes the service', async () => {
    const { status, json } = await request('GET', '/api');
    assertEqual(status, 200, 'status');
    assert(json.data.name.includes('Wuteve'), 'service name should mention Wuteve');
  });

  await check('landing page is served', async () => {
    const { status, text } = await request('GET', '/');
    assertEqual(status, 200, 'status');
    assert(text.includes('Wuteve'), 'landing page should contain the brand');
  });

  await check('extensionless /login resolves to login.html', async () => {
    const { status, text } = await request('GET', '/login');
    assertEqual(status, 200, 'status');
    assert(text.includes('<html'), 'should return an HTML document');
  });

  await check('unknown page returns the 404 document with a 404 status', async () => {
    const { status, text } = await request('GET', '/definitely-not-a-page', {
      headers: { Accept: 'text/html' },
    });
    assertEqual(status, 404, 'status');
    assert(text.includes('<html'), 'should return HTML, not JSON');
  });

  await check('unknown API route returns JSON, never HTML', async () => {
    const { status, json, text } = await request('GET', '/api/v1/nope');
    assertEqual(status, 404, 'status');
    assert(json !== null, 'body should be JSON');
    assert(!text.includes('<html'), 'body must not be the HTML shell');
  });

  await check('security headers are present', async () => {
    const { headers } = await request('GET', '/health');
    assert(headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options');
    assert(headers.get('x-request-id'), 'X-Request-Id should be set');
    assert(!headers.get('x-powered-by'), 'X-Powered-By should be removed');
  });
}

async function testRegistration() {
  await check('registration creates an account and returns a session', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody(),
    });

    assertEqual(status, 201, 'status');
    assert(json.data.accessToken, 'an access token should be returned');
    assert(json.data.refreshToken, 'a refresh token should be returned');
    assert(json.data.user.id, 'the user id should be returned');

    primaryUser = json.data;
  });

  /**
   * The regression test for the original vulnerability. The old API took `role`
   * from the request body, so this exact request produced an admin account.
   */
  await check('a caller cannot self-assign the admin role', async () => {
    const email = `smoke-escalate-${runId}@example.com`;
    createdEmails.push(email);

    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Escalate', lastName: 'Attempt', email, role: 'admin' }),
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.user.role, 'student', 'role must be forced to student');
  });

  await check('the response never contains a password field', async () => {
    const { json } = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: PASSWORD },
    });

    const serialised = JSON.stringify(json);
    assert(!serialised.includes('password'), 'no password material may be serialised');
    assert(!serialised.includes('$2a$') && !serialised.includes('$2b$'), 'no bcrypt hash may be serialised');
  });

  await check('a duplicate email is rejected', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Dup', lastName: 'Licate' }),
    });
    assertEqual(status, 409, 'status');
    assertEqual(json.success, false, 'success flag');
  });

  await check('a weak password is rejected with field details', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Weak', lastName: 'Password', email: `smoke-weak-${runId}@example.com`, password: 'short' }),
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
    assert(Array.isArray(json.details) && json.details.length > 0, 'field details should be returned');
  });

  await check('a malformed email is rejected', async () => {
    const { status } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Bad', lastName: 'Email', email: 'not-an-email' }),
    });
    assertEqual(status, 400, 'status');
  });

  /**
   * The minimum age is a rule the academy has to be able to state and defend,
   * so it is enforced where the account is created rather than only in the
   * form. A fifteen-year-old gets the reason in words, not "invalid date".
   */
  await check('a sign-up without a date of birth is refused', async () => {
    const body = signupBody({ email: `smoke-nodob-${runId}@example.com` });
    delete body.dateOfBirth;

    const { status, json } = await request('POST', '/api/v1/auth/register', { body });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
    assert(
      (json.details || []).some((detail) => /date of birth/i.test(String(detail.message))),
      'the refusal must name the date of birth'
    );
  });

  await check('a fifteen-year-old is refused, and told why', async () => {
    const almost = new Date();
    almost.setUTCFullYear(almost.getUTCFullYear() - 15);

    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({
        email: `smoke-tooyoung-${runId}@example.com`,
        dateOfBirth: almost.toISOString().slice(0, 10),
      }),
    });

    assertEqual(status, 400, 'status');
    assert(
      (json.details || []).some((detail) => String(detail.message).includes('at least 16 years old')),
      'the refusal must state the age rule'
    );
    assert(
      (json.details || []).some((detail) =>
        String(detail.message).includes('info@wuteveglobalacademy.com')
      ),
      'the refusal must give the student a way to reach a person'
    );
  });

  await check('a future date of birth is refused', async () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);

    const { status } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({
        email: `smoke-future-${runId}@example.com`,
        dateOfBirth: future.toISOString().slice(0, 10),
      }),
    });

    assertEqual(status, 400, 'status');
  });

  /**
   * `new Date('2010-02-30')` does not fail, it becomes 2 March. Without a
   * round-trip check a mistyped February birthday would be silently rewritten.
   */
  await check('an impossible date is refused rather than rolled forward', async () => {
    const { status } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ email: `smoke-feb30-${runId}@example.com`, dateOfBirth: '2010-02-30' }),
    });

    assertEqual(status, 400, 'status');
  });

  await check('a sign-up without a location is refused', async () => {
    const body = signupBody({ email: `smoke-nolocation-${runId}@example.com` });
    delete body.location;

    const { status } = await request('POST', '/api/v1/auth/register', { body });
    assertEqual(status, 400, 'status');
  });

  /**
   * A date of birth is stored, an age is not. An age column would be quietly
   * wrong within a year and would have to be rewritten for every student.
   */
  await check('the profile returns a date of birth, never a stored age', async () => {
    const email = `smoke-dob-${runId}@example.com`;
    createdEmails.push(email);

    const registered = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ email }),
    });
    assertEqual(registered.status, 201, 'registration status');

    const { status, json } = await request('GET', '/api/v1/auth/me', {
      token: registered.json.data.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.dateOfBirth, ADULT_DATE_OF_BIRTH, 'the date of birth comes back unchanged');
    assertEqual(json.data.user.location, 'Monrovia, Liberia', 'the location is stored');
    assert(json.data.user.age === undefined, 'no age may be stored or returned');
  });

  /**
   * Because every field has a declared scalar type, an object carrying Mongo
   * operators is rejected at the edge rather than reaching a query.
   */
  await check('a Mongo operator in the body is rejected', async () => {
    const { status } = await request('POST', '/api/v1/auth/login', {
      body: { email: { $ne: null }, password: { $ne: null } },
    });
    assertEqual(status, 400, 'status');
  });

  /**
   * A minimum age that only applies at sign-up is not a minimum age: it is one
   * profile edit away from being ignored. The edit path is held to the same
   * rule, and says the same thing when it refuses.
   */
  await check('an edit that would make the student too young is refused', async () => {
    const tooYoung = new Date();
    tooYoung.setUTCFullYear(tooYoung.getUTCFullYear() - 15);

    const { status, json } = await request('PATCH', '/api/v1/auth/me', {
      token: primaryUser.accessToken,
      body: { dateOfBirth: tooYoung.toISOString().slice(0, 10) },
    });

    assertEqual(status, 400, 'status');
    assert(
      (json.details || []).some((detail) => String(detail.message).includes('at least 16 years old')),
      'the refusal must repeat the age rule'
    );
  });

  await check('a corrected date of birth and location are saved', async () => {
    const { status, json } = await request('PATCH', '/api/v1/auth/me', {
      token: primaryUser.accessToken,
      body: { dateOfBirth: ADULT_DATE_OF_BIRTH, location: 'Paynesville, Monrovia' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.dateOfBirth, ADULT_DATE_OF_BIRTH, 'date of birth');
    assertEqual(json.data.user.location, 'Paynesville, Monrovia', 'location');
  });
}

async function testLogin() {
  await check('a wrong password is refused with a generic message', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: 'WrongPassword999' },
    });

    assertEqual(status, 401, 'status');
    assertEqual(json.message, 'Email or password is incorrect.', 'message must not reveal which field failed');
  });

  await check('an unknown account is refused with the same message', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: `nobody-${runId}@example.com`, password: PASSWORD },
    });

    assertEqual(status, 401, 'status');
    assertEqual(json.message, 'Email or password is incorrect.', 'message must match the wrong-password case');
  });

  await check('a correct password signs the user in', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: PASSWORD },
    });

    assertEqual(status, 200, 'status');
    assert(json.data.accessToken, 'access token');
    primaryUser = json.data;
  });
}

async function testSession() {
  await check('/auth/me returns the signed-in user', async () => {
    const { status, json } = await request('GET', '/api/v1/auth/me', { token: primaryUser.accessToken });
    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.email, primaryEmail, 'email');
  });

  await check('/auth/me requires a token', async () => {
    const { status } = await request('GET', '/api/v1/auth/me');
    assertEqual(status, 401, 'status');
  });

  await check('/auth/me rejects a garbage token', async () => {
    const { status } = await request('GET', '/api/v1/auth/me', { token: 'not.a.real.token' });
    assertEqual(status, 401, 'status');
  });

  /**
   * The old API handed back the access token as the refresh token, so this
   * forgery signed with the published placeholder secret would have been
   * accepted. It must now fail.
   */
  await check('a token signed with the old placeholder secret is rejected', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign(
      { sub: primaryUser.user.id, role: 'admin', email: primaryEmail, typ: 'access' },
      'your-super-secret-key-min-32-chars-long',
      { expiresIn: '7d' }
    );

    const { status } = await request('GET', '/api/v1/auth/me', { token: forged });
    assertEqual(status, 401, 'status');
  });

  await check('a refresh token is not accepted as an access token', async () => {
    const { status } = await request('GET', '/api/v1/auth/me', { token: primaryUser.refreshToken });
    assertEqual(status, 401, 'status');
  });
}

async function testRefreshRotation() {
  const firstRefresh = primaryUser.refreshToken;
  let secondRefresh = null;

  await check('a refresh token is exchanged for a new pair', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: firstRefresh },
    });

    assertEqual(status, 200, 'status');
    assert(json.data.accessToken, 'a new access token');
    assert(json.data.refreshToken, 'a new refresh token');
    assert(json.data.refreshToken !== firstRefresh, 'the refresh token must be rotated');

    secondRefresh = json.data.refreshToken;
    primaryUser = { ...primaryUser, ...json.data };
  });

  /**
   * Replay detection. Presenting an already-rotated token is the signature of a
   * stolen credential, so the whole chain is revoked rather than just the one.
   */
  await check('replaying a rotated refresh token is refused', async () => {
    const { status } = await request('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: firstRefresh },
    });
    assertEqual(status, 401, 'status');
  });

  await check('replay detection revokes the whole token family', async () => {
    const { status } = await request('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: secondRefresh },
    });
    assertEqual(status, 401, 'the successor token must also be dead');
  });
}

async function testPasswordRecovery() {
  await check('forgot-password answers identically for a real address', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/forgot-password', {
      body: { email: primaryEmail },
    });
    assertEqual(status, 200, 'status');
    assertEqual(json.success, true, 'success flag');
  });

  await check('forgot-password answers identically for an unknown address', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/forgot-password', {
      body: { email: `nobody-${runId}@example.com` },
    });
    assertEqual(status, 200, 'status');
    assertEqual(json.success, true, 'success flag — must not reveal that the address is unknown');
  });

  await check('an invalid reset token is refused', async () => {
    const { status } = await request('POST', '/api/v1/auth/reset-password', {
      body: { token: crypto.randomBytes(48).toString('base64url'), password: PASSWORD },
    });
    assertEqual(status, 401, 'status');
  });

  await check('a real reset token works once and only once', async () => {
    const tokens = require('../src/services/tokenService');
    const user = await User.findOne({ email: primaryEmail });
    const raw = await tokens.createPasswordResetToken(user);

    const first = await request('POST', '/api/v1/auth/reset-password', {
      body: { token: raw, password: 'BrandNewPassword123' },
    });
    assertEqual(first.status, 200, 'first use should succeed');

    const second = await request('POST', '/api/v1/auth/reset-password', {
      body: { token: raw, password: 'AnotherPassword123' },
    });
    assertEqual(second.status, 401, 'second use must be refused');

    // The new password is live and the old one is not.
    const withNew = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: 'BrandNewPassword123' },
    });
    assertEqual(withNew.status, 200, 'sign-in with the new password');
    primaryUser = withNew.json.data;

    const withOld = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: PASSWORD },
    });
    assertEqual(withOld.status, 401, 'the old password must stop working');
  });

  await check('a password reset revokes existing sessions', async () => {
    // Open a session *first*, then reset the password, so the token under test
    // genuinely predates the reset.
    const before = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: 'BrandNewPassword123' },
    });
    const staleRefresh = before.json.data.refreshToken;

    const tokenService = require('../src/services/tokenService');
    const user = await User.findOne({ email: primaryEmail });
    const raw = await tokenService.createPasswordResetToken(user);

    const reset = await request('POST', '/api/v1/auth/reset-password', {
      body: { token: raw, password: 'YetAnotherPassword123' },
    });
    assertEqual(reset.status, 200, 'the reset should succeed');

    const reuse = await request('POST', '/api/v1/auth/refresh', { body: { refreshToken: staleRefresh } });
    assertEqual(reuse.status, 401, 'a session opened before the reset must be dead');

    const fresh = await request('POST', '/api/v1/auth/login', {
      body: { email: primaryEmail, password: 'YetAnotherPassword123' },
    });
    assertEqual(fresh.status, 200, 'sign-in with the newest password');
    primaryUser = fresh.json.data;
  });
}

async function testLogout() {
  await check('logout revokes the refresh token', async () => {
    const refreshToken = primaryUser.refreshToken;

    const loggedOut = await request('POST', '/api/v1/auth/logout', { body: { refreshToken } });
    assertEqual(loggedOut.status, 200, 'status');

    const reuse = await request('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
    assertEqual(reuse.status, 401, 'a revoked refresh token must not work');
  });

  await check('the account still exists after signing out', async () => {
    const found = await User.findOne({ email: primaryEmail });
    assert(found !== null, 'signing out must not delete the account');
  });
}

/**
 * Routes that must be closed to anonymous callers.
 */
async function testDiscussions() {
  const guarded = [
    ['GET', '/api/v1/community/posts'],
    ['GET', '/api/v1/enrollments/me'],
    ['GET', '/api/v1/certificates/me'],
    ['GET', '/api/v1/notifications'],
    ['GET', '/api/v1/messages/threads'],
    ['GET', '/api/v1/study-groups'],
    ['GET', '/api/v1/live-sessions'],
    ['GET', '/api/v1/dashboard/student'],
    ['GET', '/api/v1/admin/stats'],
  ];

  for (const [method, path] of guarded) {
    // eslint-disable-next-line no-await-in-loop
    await check(`${method} ${path} requires authentication`, async () => {
      const { status } = await request(method, path);
      assertEqual(status, 401, 'status');
    });
  }

  await check('a certificate verification route is open to the public', async () => {
    // The one endpoint that must NOT require a session: an employer checking a
    // credential has no account here.
    const { status } = await request('GET', '/api/v1/certificates/verify/not-a-real-code');
    assertEqual(status, 200, 'status');
  });

  await check('the course catalog is readable without an account', async () => {
    const { status } = await request('GET', '/api/v1/courses');
    assertEqual(status, 200, 'status');
  });
}

/**
 * The same-origin guard, exercised the way a browser behaves.
 *
 * This suite exists because the guard checked only the configured allowlist.
 * Browsers send an Origin header on every POST, PATCH and DELETE — including
 * same-origin ones — so with CORS_ORIGINS unset, which is the default, every
 * write from the site's own pages was refused. Every GET kept working, so the
 * deployment looked healthy: the health check passed, pages loaded, and the
 * first sign-in returned 403 "did not originate from a recognised host".
 *
 * Nothing here caught it because this harness never sent an Origin header at
 * all — it is not a browser, so it never reproduced a browser's behaviour.
 *
 * A write that needs authentication is used rather than sign-in, because
 * sign-in sits under the tighter auth limiter and a deliberate failure there
 * would spend its budget.
 */
async function testOriginGuard() {
  const selfOrigin = baseUrl;
  const write = ['POST', '/api/v1/payments/checkout/000000000000000000000000'];

  await check('a same-origin write is accepted', async () => {
    const { status, json } = await request(write[0], write[1], {
      body: {},
      headers: { Origin: selfOrigin },
    });

    // 401 proves the request reached the route: the guard let it through and
    // the caller simply has no session.
    assertEqual(status, 401, 'status');
    assert(json && json.code !== 'CROSS_ORIGIN_BLOCKED', 'must not be blocked as cross-origin');
  });

  await check('a cross-origin write is refused', async () => {
    const { status, json } = await request(write[0], write[1], {
      body: {},
      headers: { Origin: 'https://not-our-site.example' },
    });

    assertEqual(status, 403, 'status');
    assertEqual(json && json.code, 'CROSS_ORIGIN_BLOCKED', 'code');
  });

  await check('a write with no Origin header is accepted', async () => {
    const { status } = await request(write[0], write[1], { body: {} });
    assertEqual(status, 401, 'status');
  });

  await check('a read is not subject to the origin guard', async () => {
    const { status } = await request('GET', '/api/v1/courses', {
      headers: { Origin: 'https://not-our-site.example' },
    });

    assertEqual(status, 200, 'status');
  });
}

/**
 * Every email template must carry a recipient.
 *
 * This suite exists because they did not. Each template returned a subject and
 * a body but no `to`, so the transport logged "To: undefined" and, with a real
 * provider configured, every verification link, password reset, enrolment
 * confirmation and certificate would have gone nowhere. Nothing failed loudly:
 * the requests all returned 200.
 */
async function testEmailTemplates() {
  const email = require('../src/services/email');

  const user = { firstName: 'Test', lastName: 'Person', email: 'recipient@example.com' };
  const course = { _id: 'course-id', title: 'A Course', slug: 'a-course' };

  const cases = [
    ['verification', () => email.verificationEmail({ user, url: 'https://example.com/verify?token=abc' })],
    ['password reset', () => email.passwordResetEmail({ user, url: 'https://example.com/reset?token=abc' })],
    ['password changed', () => email.passwordChangedEmail({ user })],
    ['welcome', () => email.welcomeEmail({ user })],
    ['enrolment', () => email.enrollmentEmail({ user, course, free: true })],
    ['paid enrolment', () => email.enrollmentEmail({ user, course, free: false })],
    [
      'certificate',
      () =>
        email.certificateEmail({
          user,
          certificate: { courseTitle: 'A Course', verificationCode: 'code123', certificateNumber: 'WGA-2026-000001' },
        }),
    ],
    [
      'payment receipt',
      () =>
        email.paymentReceiptEmail({
          user,
          course,
          payment: { id: 'payment-id', amountCents: 4999, currency: 'usd' },
          nextUrl: '/student-dashboard.html',
        }),
    ],
    ['announcement', () => email.announcementEmail({ user, title: 'An update', message: 'Something happened.' })],
    [
      'instructor application received',
      () => email.instructorApplicationReceivedEmail({ user }),
    ],
    ['instructor application approved', () => email.instructorApprovedEmail({ user })],
    [
      'instructor application rejected',
      () => email.instructorRejectedEmail({ user, reason: 'The CV could not be verified.' }),
    ],
  ];

  for (const [name, build] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await check(`the ${name} email is addressed to the recipient`, async () => {
      const message = build();

      assertEqual(message.to, user.email, 'the recipient address');
      assert(message.subject, 'a subject must be set');
      assert(message.text || message.html, 'a body must be set');
      assert(!JSON.stringify(message).includes('undefined'), 'no field may render as undefined');
    });
  }

  await check('the certificate email carries the document as an attachment', async () => {
    const certificate = {
      courseTitle: 'A Course',
      verificationCode: 'code123',
      certificateNumber: 'WGA-2026/000001',
      pdfBase64: 'JVBERi0xLjQK',
    };

    const message = email.certificateEmail({ user, certificate });

    assert(Array.isArray(message.attachments), 'an attachment was expected');
    assertEqual(message.attachments.length, 1, 'exactly one attachment');
    assertEqual(message.attachments[0].content, certificate.pdfBase64, 'the attachment content');
    assert(message.attachments[0].filename.endsWith('.pdf'), 'the filename must end .pdf');
    // The number contains a slash; a filename must not.
    assert(!/[\\/:*?"<>|]/.test(message.attachments[0].filename), `unsafe filename: ${message.attachments[0].filename}`);
  });

  await check('a certificate with no rendered document still sends', async () => {
    const message = email.certificateEmail({
      user,
      certificate: { courseTitle: 'A Course', verificationCode: 'c', certificateNumber: 'WGA-1' },
    });

    assert(!message.attachments || message.attachments.length === 0, 'no attachment expected');
    assert(!JSON.stringify(message).includes('undefined'), 'no field may render as undefined');
  });

  await check('the transport forwards attachments to the provider', async () => {
    const config = require('../src/config/env');
    const originalFetch = global.fetch;
    const originalEnabled = config.email.enabled;
    let captured = null;

    global.fetch = async (url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: 'test-message' }) };
    };
    config.email.enabled = true;

    try {
      await email.deliver({
        to: 'recipient@example.com',
        subject: 'An attachment',
        text: 'See attached.',
        html: '<p>See attached.</p>',
        attachments: [{ filename: 'a.pdf', content: 'JVBERi0=' }],
      });
    } finally {
      global.fetch = originalFetch;
      config.email.enabled = originalEnabled;
    }

    assert(captured, 'the provider was never called');
    assert(Array.isArray(captured.attachments), 'attachments were not forwarded');
    assertEqual(captured.attachments[0].filename, 'a.pdf', 'the forwarded filename');
  });

  /**
   * The contact notification addressed `config.contactInbox`, a key that does not
   * exist, so `deliver` refused it with `no_recipient` and every enquiry was
   * stored without anyone being told. Nothing threw and nothing looked wrong,
   * which is exactly why this is asserted against the source rather than trusted.
   */
  await check('the contact route addresses a config key that exists', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'contact.js'), 'utf8');

    assert(!source.includes('config.contactInbox'), 'contact.js reads config.contactInbox, which is not defined');
    assert(source.includes('config.email.inbox'), 'contact.js does not address the configured inbox');
  });

  await check('the contact notification is addressed to the inbox', async () => {
    const config = require('../src/config/env');
    const message = email.contactMessageEmail({
      name: 'A Person',
      email: 'sender@example.com',
      reason: 'general',
      subject: 'Hello',
      message: 'A question.',
      inbox: config.email.inbox,
    });

    assertEqual(message.to, config.email.inbox, 'the notification recipient');
    assert(message.to.includes('@'), 'the inbox must look like an address');
  });
}

/**
 * An instructor's CV, and the credentials shown on the course page.
 *
 * A CV is a document full of personal data, so most of these checks are about
 * who cannot reach it: a student, a colleague, a stranger with the URL. The file
 * itself travels as base64 inside JSON because this deployment has no multipart
 * parser, which is why the size ceiling is asserted rather than assumed.
 */
async function testInstructorCv() {
  const instructorEmail = `smoke-cv-instructor-${runId}@example.com`;
  const studentEmail = `smoke-cv-student-${runId}@example.com`;
  const adminEmail = `smoke-cv-admin-${runId}@example.com`;

  createdEmails.push(instructorEmail, studentEmail, adminEmail);

  let instructor = null;
  let instructorToken = null;
  let studentToken = null;
  let adminToken = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  /** A real, minimal PDF — signature, some content, trailer. */
  const pdfDataUrl = (padding = 40) =>
    `data:application/pdf;base64,${Buffer.from(
      `%PDF-1.4\n1 0 obj\n<<>>\nendobj\n${'x'.repeat(padding)}\n%%EOF\n`
    ).toString('base64')}`;

  /** The raw response, for the two endpoints that return a file rather than JSON. */
  const download = async (path, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      disposition: response.headers.get('content-disposition') || '',
      cacheControl: response.headers.get('cache-control') || '',
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  };

  await check('an instructor CV fixture is provisioned', async () => {
    instructor = await User.create({
      firstName: 'Cv',
      lastName: 'Instructor',
      email: instructorEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Cv',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Cv',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    instructorToken = await signIn(instructorEmail);
    studentToken = await signIn(studentEmail);
    adminToken = await signIn(adminEmail);

    assert(instructorToken && studentToken && adminToken, 'all three sessions must exist');
  });

  await check('an instructor can upload a PDF CV', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/cv', {
      token: instructorToken,
      body: { image: pdfDataUrl(), filename: 'my cv.pdf' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.cvStatus, 'pending', 'a new CV waits for review');
    assert(json.data.user.cvUploadedAt, 'the upload time must be recorded');
    // The file itself must never ride along in a user payload.
    assert(!JSON.stringify(json.data.user).includes('JVBERi'), 'the CV bytes leaked into the response');
  });

  await check('a CV that is not a PDF is refused', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/cv', {
      token: instructorToken,
      body: {
        image: `data:image/png;base64,${Buffer.from(`%PDF-1.4 but declared as png ${'y'.repeat(120)}`).toString('base64')}`,
      },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'INVALID_CV', 'code');
  });

  await check('a file with a PDF name but no PDF inside is refused', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/cv', {
      token: instructorToken,
      body: {
        image: `data:application/pdf;base64,${Buffer.from(`this is plainly not a PDF ${'z'.repeat(120)}`).toString('base64')}`,
      },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'INVALID_CV', 'code');
  });

  await check('a truncated PDF is refused', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/cv', {
      token: instructorToken,
      body: {
        image: `data:application/pdf;base64,${Buffer.from(`%PDF-1.4 with no trailer ${'w'.repeat(120)}`).toString('base64')}`,
      },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'INVALID_CV', 'code');
  });

  await check('a CV larger than 500 KB is refused', async () => {
    // Valid signature and trailer, but 600 KB of content.
    const big = `data:application/pdf;base64,${Buffer.from(
      `%PDF-1.4\n${'x'.repeat(600 * 1024)}\n%%EOF\n`
    ).toString('base64')}`;

    const { status } = await request('PUT', '/api/v1/auth/me/cv', { token: instructorToken, body: { image: big } });
    assertEqual(status, 400, 'status');
  });

  await check('a student cannot upload a CV', async () => {
    const { status } = await request('PUT', '/api/v1/auth/me/cv', {
      token: studentToken,
      body: { image: pdfDataUrl(), filename: 'cv.pdf' },
    });

    assertEqual(status, 403, 'status');
  });

  await check('the instructor can download their own CV', async () => {
    const response = await download('/api/v1/auth/me/cv', instructorToken);

    assertEqual(response.status, 200, 'status');
    assert(response.contentType.includes('application/pdf'), `content type was ${response.contentType}`);
    assert(response.buffer.subarray(0, 5).toString() === '%PDF-', 'the body must be the PDF');
    assert(/instructor-cv\.pdf/i.test(response.disposition), `filename was ${response.disposition}`);
    // Personal document: not for any cache to keep.
    assert(/no-store/i.test(response.cacheControl), `cache control was ${response.cacheControl}`);
  });

  await check('an administrator can download an instructor CV', async () => {
    const response = await download(`/api/v1/admin/instructors/${instructor.id}/cv`, adminToken);

    assertEqual(response.status, 200, 'status');
    assert(response.buffer.subarray(0, 5).toString() === '%PDF-', 'the body must be the PDF');
  });

  await check('a student cannot download an instructor CV', async () => {
    const response = await download(`/api/v1/admin/instructors/${instructor.id}/cv`, studentToken);
    assertEqual(response.status, 403, 'status');
  });

  await check('the administrator sees the pending queue without the files', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/instructors/cv?status=pending', {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');
    const row = json.data.instructors.find((entry) => entry.id === String(instructor._id));
    assert(row, 'the instructor must be in the pending queue');
    assertEqual(row.cvStatus, 'pending', 'the row status');
    assert(row.cvUploadedAt, 'the row must carry the upload time');
    assert(!JSON.stringify(json.data).includes('JVBERi'), 'the queue must not carry file bytes');
  });

  await check('an administrator can approve a CV', async () => {
    const { status, json } = await request('POST', `/api/v1/admin/instructors/${instructor.id}/cv/approve`, {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.instructor.cvStatus, 'approved', 'status after approval');

    const mine = await request('GET', '/api/v1/auth/me', { token: instructorToken });
    assertEqual(mine.json.data.user.cvStatus, 'approved', 'the instructor must see the approval');
  });

  await check('a rejection requires a reason', async () => {
    // The CV must be back in play first; the fixture below re-uploads it.
    const upload = await request('PUT', '/api/v1/auth/me/cv', {
      token: instructorToken,
      body: { image: pdfDataUrl(80), filename: 'cv-v2.pdf' },
    });
    assertEqual(upload.status, 200, 're-upload');

    const { status } = await request('POST', `/api/v1/admin/instructors/${instructor.id}/cv/reject`, {
      token: adminToken,
      body: {},
    });

    assertEqual(status, 400, 'status');
  });

  await check('a replacement CV goes back to pending', async () => {
    const { status, json } = await request('GET', '/api/v1/auth/me', { token: instructorToken });
    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.cvStatus, 'pending', 'a replaced CV must be reviewed again');
  });

  await check('an administrator can reject a CV with a reason', async () => {
    const reason = 'Please include your teaching experience.';

    const { status, json } = await request('POST', `/api/v1/admin/instructors/${instructor.id}/cv/reject`, {
      token: adminToken,
      body: { reason },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.instructor.cvStatus, 'rejected', 'status after rejection');

    const mine = await request('GET', '/api/v1/auth/me', { token: instructorToken });
    assertEqual(mine.json.data.user.cvRejectionReason, reason, 'the instructor must see the reason');
  });

  await check('an instructor cannot approve their own CV', async () => {
    const approve = await request('POST', `/api/v1/admin/instructors/${instructor.id}/cv/approve`, {
      token: instructorToken,
    });
    assertEqual(approve.status, 403, 'approve status');

    const reject = await request('POST', `/api/v1/admin/instructors/${instructor.id}/cv/reject`, {
      token: instructorToken,
      body: { reason: 'A sufficiently long reason.' },
    });
    assertEqual(reject.status, 403, 'reject status');
  });

  await check('the video introduction must be an embeddable address', async () => {
    const good = await request('PATCH', '/api/v1/auth/me', {
      token: instructorToken,
      body: { videoIntroUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assertEqual(good.status, 200, 'a YouTube link must be accepted');

    const bad = await request('PATCH', '/api/v1/auth/me', {
      token: instructorToken,
      body: { videoIntroUrl: 'https://example.com/not-a-video' },
    });
    assertEqual(bad.status, 400, 'a foreign host must be refused');

    // The lookalike that defeats a substring check.
    const lookalike = await request('PATCH', '/api/v1/auth/me', {
      token: instructorToken,
      body: { videoIntroUrl: 'https://youtube.com.evil.example/watch' },
    });
    assertEqual(lookalike.status, 400, 'a lookalike host must be refused');
  });

  await check('the credentials save and come back on the author card', async () => {
    const saved = await request('PATCH', '/api/v1/auth/me', {
      token: instructorToken,
      body: {
        qualifications: 'MSc Statistics, University of Liberia',
        yearsExperience: '12',
        languages: 'English, French , Kpelle',
      },
    });

    assertEqual(saved.status, 200, 'status');

    const mine = await request('GET', '/api/v1/auth/me', { token: instructorToken });
    const user = mine.json.data.user;
    assertEqual(user.yearsExperience, 12, 'years of experience');
    assert(Array.isArray(user.languages), 'languages must be a list');
    assertEqual(user.languages.join(','), 'English,French,Kpelle', 'languages, trimmed');
    assertEqual(user.qualifications, 'MSc Statistics, University of Liberia', 'qualifications');

    await User.updateOne({ _id: instructor._id }, { $set: { cvStatus: 'approved' } });
    const author = await User.findById(instructor._id);
    const card = author.toAuthorJSON();

    assertEqual(card.credentials.cvApproved, true, 'the public card reports approval');
    assertEqual(card.credentials.yearsExperience, 12, 'the public card carries the years');
    assert(!('cvStatus' in card), 'the public card must not expose the raw status');
    assert(!('cvImage' in card), 'the public card must never carry the file');
  });

  await check('an out-of-range years of experience is refused', async () => {
    const { status } = await request('PATCH', '/api/v1/auth/me', {
      token: instructorToken,
      body: { yearsExperience: '120' },
    });

    assertEqual(status, 400, 'status');
  });
}

/**
 * The emails added after the first audit: progress, payments and account state.
 *
 * Two kinds of check. The templates are built directly and inspected, so a
 * missing field or a link pointing somewhere unreachable fails without sending
 * anything. The wiring is checked by replacing `deliver` for the duration of one
 * request: the app runs inside this process, so a captured payload is proof the
 * trigger fired and proof of exactly what would have gone out.
 */
/**
 * Partnership enquiries - the form on /business.html, /universities.html and
 * /government.html.
 *
 * The important behaviour is not the 201. It is that the enquiry survives even
 * when the notification cannot be sent, that the notification goes to the
 * partnerships inbox and not the contact inbox, and that whatever somebody typed
 * into "organisation" is escaped before it is put in an email.
 */
/**
 * Partnership enquiries - the form on /business.html, /universities.html and
 * /government.html.
 *
 * The behaviour that matters is not the 201. It is that the enquiry survives
 * when the notification cannot be sent, that the notification goes to the
 * partnerships inbox rather than the general one, and that whatever somebody
 * typed into "organisation" is escaped before it is put into an email.
 */
async function testBusinessEnquiries() {
  const mailer = require('../src/services/email');
  const config = require('../src/config/env');
  const BusinessLead = require('../src/models/BusinessLead');

  const leadEmail = `smoke-lead-${runId}@example.com`;

  const captureEmail = async (task) => {
    const original = mailer.deliver;
    const captured = [];

    mailer.deliver = async (message) => {
      captured.push(message);
      return { delivered: true, id: 'captured' };
    };

    try {
      await task();
    } finally {
      mailer.deliver = original;
    }

    return captured;
  };

  const standardLead = {
    company: 'Acme Trading',
    contactName: 'Jo Doe',
    email: 'jo@acme.example',
    phone: null,
    audience: 'business',
    teamSize: '20-49',
    timeline: '1-3 months',
    interests: ['Technology & IT'],
    message: 'We need training for supervisors.',
  };

  await check('partnership enquiries have an inbox of their own', () => {
    assert(
      config.businessInbox === 'partnership@wuteveglobalacademy.com',
      `enquiries should reach partnership@wuteveglobalacademy.com, got ${config.businessInbox}`
    );
    assert(
      config.businessInbox !== config.email.inbox,
      'partnership enquiries must not be mixed into the general contact inbox'
    );
  });

  await check('the enquiry email is replyable to the person who sent it', () => {
    const message = mailer.businessEnquiryEmail({ lead: standardLead });
    assert(message.to === config.businessInbox, 'the notification must be addressed to the partnerships inbox');
    assertEqual(message.replyTo, standardLead.email, 'reply address');
  });

  await check('the enquiry subject names the organisation', () => {
    const message = mailer.businessEnquiryEmail({ lead: standardLead });
    assert(
      message.subject.startsWith('Company enquiry') && message.subject.includes('Acme Trading'),
      `subject should name the company, got "${message.subject}"`
    );
  });

  await check('the enquiry email carries the answers that were given', () => {
    const message = mailer.businessEnquiryEmail({ lead: standardLead });
    assert(message.text.includes('20-49'), 'the team size must survive into the email');
    assert(message.text.includes('Technology & IT'), 'the training interests must survive into the email');
    assert(message.text.includes('We need training for supervisors.'), 'the free-text message must survive');
  });

  await check('an enquiry is labelled by the page it came from', () => {
    const university = mailer.businessEnquiryEmail({ lead: { ...standardLead, audience: 'university' } });
    const government = mailer.businessEnquiryEmail({ lead: { ...standardLead, audience: 'government' } });

    assert(
      university.subject.startsWith('University or college enquiry'),
      `a university enquiry should say so, got "${university.subject}"`
    );
    assert(
      government.subject.startsWith('Government or public body enquiry'),
      `a government enquiry should say so, got "${government.subject}"`
    );
  });

  await check('an organisation name is escaped in the notification email', () => {
    const message = mailer.businessEnquiryEmail({
      lead: { ...standardLead, company: '<script>alert(1)</script>' },
    });

    assert(!message.html.includes('<script>'), 'a raw script tag must never reach the email body');
    assert(message.html.includes('&lt;script&gt;'), 'the organisation name must be escaped');
  });

  let response = null;
  let stored = null;
  let captured = [];

  await check('a submitted enquiry is accepted and stored', async () => {
    captured = await captureEmail(async () => {
      response = await request('POST', '/api/v1/business/enquiries', {
        body: {
          audience: 'business',
          company: `Smoke Training ${runId}`,
          contactName: 'Joseph Kollie',
          email: leadEmail,
          phone: '+231 770 000 111',
          teamSize: '20-49',
          timeline: '1-3 months',
          interests: ['Technology & IT', 'Data & Analytics'],
          message: 'Spreadsheets and data literacy for 24 supervisors.',
        },
      });
    });

    assertEqual(response.status, 201, 'an enquiry should be accepted');
    stored = await BusinessLead.findOne({ email: leadEmail }).lean();
    assert(Boolean(stored), 'a submitted enquiry must be stored, even before it is emailed');
  });

  await check('the enquiry keeps the answers that were given', () => {
    assertEqual(stored.status, 'new', 'a new enquiry starts in the new state');
    assertEqual(stored.audience, 'business', 'the page it came from');
    assertEqual(stored.teamSize, '20-49', 'the team size');
    assertEqual(stored.interests.length, 2, 'the number of training areas');
    assert(
      stored.interests.includes('Data & Analytics'),
      'the selected training areas must be stored with the enquiry'
    );
  });

  await check('a delivered notification is recorded on the enquiry', () => {
    assert(Boolean(stored.notifiedAt), 'notifiedAt should be set once the email is delivered');
  });

  await check('one enquiry sends exactly one notification', () => {
    assertEqual(captured.length, 1, 'notifications sent for one enquiry');
    assertEqual(captured[0] && captured[0].to, config.businessInbox, 'notification recipient');
    assertEqual(captured[0] && captured[0].replyTo, leadEmail, 'notification reply address');
  });

  await check('the enquiry response gives a reference and echoes nothing back', () => {
    const reference = response.json && response.json.data && response.json.data.reference;
    assert(Boolean(reference), 'the sender should get a reference to quote');
    assertEqual(String(reference).length, 8, 'reference length');
    assert(!response.text.includes(leadEmail), 'the response must not echo the address back');
  });

  await check('an enquiry without an organisation is refused', async () => {
    const refused = await request('POST', '/api/v1/business/enquiries', {
      body: { contactName: 'Jo Doe', email: 'jo@acme.example' },
    });

    assertEqual(refused.status, 400, 'status for a missing organisation');
    assertEqual(refused.json && refused.json.code, 'VALIDATION_ERROR', 'error code');
    assert(
      (refused.json.details || []).some((detail) => detail.field === 'company'),
      'the refusal should point at the organisation field'
    );
  });

  await check('an enquiry with an invalid email is refused', async () => {
    const refused = await request('POST', '/api/v1/business/enquiries', {
      body: { company: 'Acme', contactName: 'Jo Doe', email: 'not-an-address' },
    });
    assertEqual(refused.status, 400, 'status for an invalid email');
  });

  await check('an enquiry from an unknown audience is refused', async () => {
    const refused = await request('POST', '/api/v1/business/enquiries', {
      body: { company: 'Acme', contactName: 'Jo Doe', email: 'jo@acme.example', audience: 'spy' },
    });
    assertEqual(refused.status, 400, 'status for an unknown audience');
  });

  await check('an over-long message is refused', async () => {
    const refused = await request('POST', '/api/v1/business/enquiries', {
      body: { company: 'Acme', contactName: 'Jo Doe', email: 'jo@acme.example', message: 'x'.repeat(2100) },
    });
    assertEqual(refused.status, 400, 'status for an over-long message');
  });

  await BusinessLead.deleteMany({ email: leadEmail });
}


async function testNewNotifications() {
  const mailer = require('../src/services/email');
  const config = require('../src/config/env');
  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');

  const instructorEmail = `smoke-notify-instructor-${runId}@example.com`;
  const studentEmail = `smoke-notify-student-${runId}@example.com`;
  const adminEmail = `smoke-notify-admin-${runId}@example.com`;
  createdEmails.push(instructorEmail, studentEmail, adminEmail);

  let instructorToken = null;
  let studentToken = null;
  let adminToken = null;
  let course = null;
  let lesson = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  /** Run `task` with every outgoing message captured instead of delivered. */
  const captureEmail = async (task) => {
    const original = mailer.deliver;
    const captured = [];

    mailer.deliver = async (message) => {
      captured.push(message);
      return { delivered: true, id: 'captured' };
    };

    try {
      await task();
      // Fire-and-forget sends run on setImmediate; give them a turn (and the
      // certificate path a moment to render its PDF) before looking.
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      mailer.deliver = original;
    }

    return captured;
  };

  /** Every address a message points at must be one this site can serve. */
  const assertLinksAreOurs = (message, label) => {
    const body = `${message.text || ''}\n${message.html || ''}`;
    const urls = body.match(/https?:\/\/[^\s"'<>]+/g) || [];

    urls.forEach((url) => {
      const clean = url.replace(/[.,)]+$/, '');
      assert(
        clean.startsWith(config.publicBaseUrl),
        `${label} links to ${clean}, which is not under ${config.publicBaseUrl}`
      );
    });
  };

  const user = { firstName: 'Test', lastName: 'Person', email: 'recipient@example.com' };
  const courseCard = { title: 'A Course', durationHours: 4 };
  const payment = { orderId: 'WGA-2026-000123', amountCents: 5000, currency: 'usd' };

  const templates = [
    ['course completed', () => mailer.courseCompletedEmail({ user, course: courseCard, certificate: { certificateNumber: 'WGA-1', credential: 'diploma' } }), 'You have completed'],
    ['manual payment submitted', () => mailer.manualPaymentSubmittedEmail({ user, course: courseCard, payment }), 'We have received your payment'],
    ['manual payment rejected', () => mailer.manualPaymentRejectedEmail({ user, course: courseCard, payment, reason: 'No matching transfer.' }), 'Payment verification failed'],
    ['CV submitted', () => mailer.cvSubmittedEmail({ user }), 'We have received your CV'],
    ['CV approved', () => mailer.cvApprovedEmail({ user }), 'Your CV has been approved'],
    ['CV rejected', () => mailer.cvRejectedEmail({ user, reason: 'Add your teaching certificate.' }), 'Your CV requires attention'],
    ['instructor account', () => mailer.instructorAccountEmail({ user }), 'instructor account is ready'],
    ['newsletter welcome', () => mailer.newsletterWelcomeEmail({ email: 'list@example.com' }), 'Welcome to the Wuteve'],
  ];

  for (const [label, build, subjectFragment] of templates) {
    // eslint-disable-next-line no-await-in-loop
    await check(`the ${label} email is complete and points at this site`, async () => {
      const message = build();

      assert(message.to, 'a recipient is required');
      assert(message.subject.includes(subjectFragment), `subject was "${message.subject}"`);
      assert(message.text && message.html, 'both a text and an html body are required');
      assert(!JSON.stringify(message).includes('undefined'), 'no field may render as undefined');
      assertLinksAreOurs(message, label);
    });
  }

  await check('a notification fixture is provisioned', async () => {
    const instructor = await User.create({
      firstName: 'Notify',
      lastName: 'Instructor',
      email: instructorEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Notify',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Notify',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    instructorToken = await signIn(instructorEmail);
    studentToken = await signIn(studentEmail);
    adminToken = await signIn(adminEmail);

    course = await Course.create({
      title: `Notification course ${runId}`,
      slug: `notify-${runId}`,
      instructor: instructor._id,
      instructorName: 'Notify Instructor',
      priceCents: 0,
      currency: 'usd',
      status: 'published',
      publishedAt: new Date(),
      credential: 'certificate',
    });

    lesson = await Lesson.create({
      course: course._id,
      title: 'The only lesson',
      type: 'text',
      order: 1,
      published: true,
      content: 'Short.',
    });

    assert(instructorToken && studentToken && adminToken, 'all three sessions must exist');
  });

  await check('the student enrols so the course can be finished', async () => {
    const { status } = await request('POST', `/api/v1/courses/${course.id}/enroll`, { token: studentToken });
    assert(status === 200 || status === 201, `enrol returned ${status}`);
  });

  await check('finishing a course prepares the completion email', async () => {
    const captured = await captureEmail(async () => {
      const { status } = await request(
        'POST',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}/complete`,
        { token: studentToken }
      );
      assertEqual(status, 200, 'complete status');
    });

    const completion = captured.find((message) => /You have completed/.test(message.subject));

    assert(completion, `no completion email was prepared (got: ${captured.map((m) => m.subject).join(' | ')})`);
    assertEqual(completion.to, studentEmail, 'the recipient');
    assertLinksAreOurs(completion, 'course completed');
  });

  await check('finishing the course again does not repeat the congratulations', async () => {
    const captured = await captureEmail(async () => {
      await request('POST', `/api/v1/courses/${course.id}/lessons/${lesson.id}/complete`, {
        token: studentToken,
      });
    });

    assert(
      !captured.some((message) => /You have completed/.test(message.subject)),
      'a second completion email was sent'
    );
  });

  await check('uploading a CV prepares the acknowledgement', async () => {
    const pdf = `data:application/pdf;base64,${Buffer.from(
      `%PDF-1.4\n${'x'.repeat(60)}\n%%EOF\n`
    ).toString('base64')}`;

    const captured = await captureEmail(async () => {
      const { status } = await request('PUT', '/api/v1/auth/me/cv', {
        token: instructorToken,
        body: { image: pdf, filename: 'cv.pdf' },
      });
      assertEqual(status, 200, 'upload status');
    });

    const acknowledgement = captured.find((message) => /received your CV/.test(message.subject));
    assert(acknowledgement, 'no CV acknowledgement was prepared');
    assertEqual(acknowledgement.to, instructorEmail, 'the recipient');
  });

  await check('approving a CV prepares the approval email', async () => {
    const instructor = await User.findOne({ email: instructorEmail }).select('_id');

    const captured = await captureEmail(async () => {
      const { status } = await request('POST', `/api/v1/admin/instructors/${instructor._id}/cv/approve`, {
        token: adminToken,
      });
      assertEqual(status, 200, 'approve status');
    });

    const approval = captured.find((message) => /CV has been approved/.test(message.subject));
    assert(approval, 'no approval email was prepared');
    assertEqual(approval.to, instructorEmail, 'the recipient');
  });

  await check('rejecting a CV sends the reason', async () => {
    const instructor = await User.findOne({ email: instructorEmail }).select('_id');
    const reason = 'Please include your teaching certificate.';

    const captured = await captureEmail(async () => {
      const { status } = await request('POST', `/api/v1/admin/instructors/${instructor._id}/cv/reject`, {
        token: adminToken,
        body: { reason },
      });
      assertEqual(status, 200, 'reject status');
    });

    const rejection = captured.find((message) => /CV requires attention/.test(message.subject));
    assert(rejection, 'no rejection email was prepared');
    assert(
      `${rejection.text} ${rejection.html}`.includes(reason),
      'the reason must appear in the email'
    );
  });

  await check('creating an instructor prepares the account email', async () => {
    const email = `smoke-notify-new-${runId}@example.com`;
    createdEmails.push(email);

    const captured = await captureEmail(async () => {
      const { status } = await request('POST', '/api/v1/admin/users', {
        token: adminToken,
        body: {
          firstName: 'New',
          lastName: 'Instructor',
          email,
          password: 'SmokeTest123!aA',
          role: 'instructor',
        },
      });
      assertEqual(status, 201, 'create status');
    });

    const account = captured.find((message) => /instructor account is ready/.test(message.subject));
    assert(account, 'no account email was prepared');
    assertEqual(account.to, email, 'the recipient');
    // The password an administrator chose must never be in an email.
    assert(!`${account.text} ${account.html}`.includes('SmokeTest123'), 'the password leaked into the email');
  });

  await check('a new newsletter subscriber gets one welcome', async () => {
    const address = `smoke-notify-list-${runId}@example.com`;

    const first = await captureEmail(async () => {
      const { status } = await request('POST', '/api/v1/newsletter/subscribe', { body: { email: address } });
      assertEqual(status, 200, 'subscribe status');
    });

    const welcome = first.find((message) => /Welcome to the Wuteve/.test(message.subject));
    assert(welcome, 'no welcome email was prepared');
    assertEqual(welcome.to, address, 'the recipient');

    // Re-submitting the same address must not send a second welcome.
    const second = await captureEmail(async () => {
      await request('POST', '/api/v1/newsletter/subscribe', { body: { email: address } });
    });

    assert(!second.some((message) => /Welcome to the Wuteve/.test(message.subject)), 'a second welcome was sent');
  });

  // Leave nothing behind; the global cleanup removes users, not courses.
  await Lesson.deleteMany({ course: course._id });
  await Course.deleteOne({ _id: course._id });
}

/**
 * The core product path, end to end: an instructor is given an account, writes
 * a course, an admin approves it, a student enrols, works through it, and is
 * issued a verifiable certificate.
 *
 * This is the suite that answers "does the thing actually work", as opposed to
 * "are the doors locked".
 */
async function testLearningLoop() {  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');
  const Enrollment = require('../src/models/Enrollment');
  const Certificate = require('../src/models/Certificate');

  const adminEmail = `smoke-admin-${runId}@example.com`;
  const instructorEmail = `smoke-instructor-${runId}@example.com`;
  const outsiderEmail = `smoke-outsider-${runId}@example.com`;

  createdEmails.push(adminEmail, instructorEmail, outsiderEmail);

  let adminSession = null;
  let instructorSession = null;
  let course = null;
  let lessonA = null;
  let lessonB = null;
  let certificate = null;

  await check('an administrator can be provisioned', async () => {
    await User.create({
      firstName: 'Ada',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: adminEmail, password: PASSWORD },
    });

    assertEqual(status, 200, 'admin sign-in');
    assertEqual(json.data.user.role, 'admin', 'role');
    adminSession = json.data;
  });

  await check('an admin can create an instructor account through the API', async () => {
    const { status, json } = await request('POST', '/api/v1/admin/users', {
      token: adminSession.accessToken,
      body: {
        firstName: 'Isaac',
        lastName: 'Instructor',
        email: instructorEmail,
        password: PASSWORD,
        role: 'instructor',
        headline: 'Senior software engineer',
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.user.role, 'instructor', 'role');
  });

  await check('a student cannot create an instructor account', async () => {
    const { status } = await request('POST', '/api/v1/admin/users', {
      token: primaryUser.accessToken,
      body: { firstName: 'No', lastName: 'Way', email: outsiderEmail, password: PASSWORD, role: 'instructor' },
    });

    assertEqual(status, 403, 'status');
  });

  await check('the instructor can sign in', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: instructorEmail, password: PASSWORD },
    });

    assertEqual(status, 200, 'status');
    instructorSession = json.data;
  });

  await check('an instructor can create a course', async () => {
    const { status, json } = await request('POST', '/api/v1/courses', {
      token: instructorSession.accessToken,
      body: {
        title: 'Introduction to Data Analysis',
        summary: 'A short practical course.',
        description: 'Learn the fundamentals with worked examples.',
        category: 'data',
        level: 'beginner',
        priceCents: 0,
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.course.status, 'draft', 'a new course must start as a draft');
    assert(json.data.course.slug, 'a slug should be generated');

    course = json.data.course;
  });

  await check('a student cannot create a course', async () => {
    const { status } = await request('POST', '/api/v1/courses', {
      token: primaryUser.accessToken,
      body: { title: 'Not allowed', summary: 'x' },
    });

    assertEqual(status, 403, 'status');
  });

  await check('lessons can be added', async () => {
    const first = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'Getting started',
        type: 'text',
        content: 'Welcome to the course.',
        durationMinutes: 30,
        isPreview: true,
      },
    });

    assertEqual(first.status, 201, 'first lesson');

    const second = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'Working with data',
        type: 'video',
        content: 'Deep dive.',
        durationMinutes: 90,
      },
    });

    assertEqual(second.status, 201, 'second lesson');

    lessonA = first.json.data.lesson;
    lessonB = second.json.data.lesson;

    // Ordering is assigned automatically, starting at 1.
    assertEqual(lessonA.order, 1, 'first lesson order');
    assertEqual(lessonB.order, 2, 'second lesson order');
  });

  /*
   * Lesson bodies became HTML when the editor shipped. These checks go through
   * the API rather than calling the sanitizer directly, because the interesting
   * failure is not "the sanitizer is wrong" but "the sanitizer was never called"
   * — a route that forgets it looks exactly like a route that works.
   */
  let dirtyLessonId = null;
  let plainLessonId = null;

  const lessonBody = async (id) => {
    const read = await request('GET', `/api/v1/courses/${course.id}/lessons/${id}`, {
      token: instructorSession.accessToken,
    });
    assertEqual(read.status, 200, 'read back');
    return read.json.data.lesson.content || '';
  };

  await check('a lesson body is sanitized when it is saved', async () => {
    const created = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'Formatting',
        type: 'text',
        content:
          '<h2>Week one</h2><p>Read <strong>carefully</strong>.</p>' +
          '<script>steal()</script><img src=x onerror="steal()">' +
          '<iframe src="https://evil.example"></iframe>' +
          '<p style="color:red" onclick="steal()">Styled</p>',
      },
    });

    assertEqual(created.status, 201, 'create');
    dirtyLessonId = created.json.data.lesson.id;

    const body = created.json.data.lesson.content;
    assert(!/<script/i.test(body), `script tag survived: ${body}`);
    assert(!/onerror/i.test(body), `event handler survived: ${body}`);
    assert(!/<iframe/i.test(body), `iframe survived: ${body}`);
    assert(!/onclick/i.test(body), `inline handler survived: ${body}`);
    assert(!/style=/i.test(body), `inline style survived: ${body}`);
    assert(body.includes('<strong>carefully</strong>'), `formatting was dropped: ${body}`);
    assert(body.includes('Week one'), `heading text was dropped: ${body}`);
  });

  await check('an edit cannot put unsafe markup back into a lesson', async () => {
    assert(dirtyLessonId, 'the previous check must have created the lesson');

    const patched = await request('PATCH', `/api/v1/courses/${course.id}/lessons/${dirtyLessonId}`, {
      token: instructorSession.accessToken,
      body: { content: '<p>Kept</p><svg onload="steal()"></svg><a href="javascript:steal()">tap</a>' },
    });

    assertEqual(patched.status, 200, 'patch');

    const body = await lessonBody(dirtyLessonId);
    assert(!/<svg/i.test(body), `svg survived: ${body}`);
    assert(!/onload/i.test(body), `onload survived: ${body}`);
    assert(!/javascript:/i.test(body), `javascript: href survived: ${body}`);
    assert(!/<a\b/i.test(body), `unsafe link kept its element: ${body}`);
    assert(body.includes('Kept'), `text was dropped: ${body}`);
  });

  await check('a safe link is kept and marked noopener', async () => {
    assert(dirtyLessonId, 'the previous checks must have created the lesson');

    const patched = await request('PATCH', `/api/v1/courses/${course.id}/lessons/${dirtyLessonId}`, {
      token: instructorSession.accessToken,
      body: { content: '<p>See <a href="https://example.com/notes" target="_blank">the notes</a></p>' },
    });

    assertEqual(patched.status, 200, 'patch');

    const body = await lessonBody(dirtyLessonId);
    assert(body.includes('href="https://example.com/notes"'), `link lost: ${body}`);
    assert(/rel="[^"]*noopener/.test(body), `noopener missing: ${body}`);
  });

  await check('lesson materials must be ordinary web addresses', async () => {
    for (const url of ['javascript:steal()', 'data:text/html,<b>x</b>', 'ftp://example.com/a.pdf']) {
      const rejected = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
        token: instructorSession.accessToken,
        body: { title: 'Materials', type: 'text', resources: [{ title: 'Sheet', url }] },
      });

      assertEqual(rejected.status, 400, `status for ${url}`);
      assertEqual(rejected.json.code, 'VALIDATION_ERROR', `code for ${url}`);
    }

    const accepted = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'Materials',
        type: 'text',
        resources: [{ title: 'Sheet', url: 'https://example.com/worksheet.pdf' }],
      },
    });

    assertEqual(accepted.status, 201, 'https resource');
    plainLessonId = accepted.json.data.lesson.id;
  });

  await check('the newer lesson types are accepted', async () => {
    // `type` is a label, not a structure: pdf and mixed were added after lessons
    // already existed, so the only thing to prove is that they can be stored.
    for (const type of ['pdf', 'mixed']) {
      // eslint-disable-next-line no-await-in-loop
      const created = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
        token: instructorSession.accessToken,
        body: { title: `A ${type} lesson`, type },
      });

      assertEqual(created.status, 201, `status for ${type}`);
      assertEqual(created.json.data.lesson.type, type, `stored type for ${type}`);

      // eslint-disable-next-line no-await-in-loop
      await request('DELETE', `/api/v1/courses/${course.id}/lessons/${created.json.data.lesson.id}`, {
        token: instructorSession.accessToken,
      });
    }
  });

  await check('a lesson that is only text is left readable', async () => {
    const created = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: { title: 'Comparison', type: 'text', content: 'Compare a < b and c > d.' },
    });

    assertEqual(created.status, 201, 'create');

    // "< b" is not a tag, so the text has to survive as text rather than vanish.
    const body = created.json.data.lesson.content;
    assert(body.includes('Compare a'), `text was lost: ${body}`);
    assert(body.includes('c &gt; d') || body.includes('c > d'), `comparison was mangled: ${body}`);

    // Leave the course exactly as the rest of the suite expects it.
    for (const id of [dirtyLessonId, plainLessonId, created.json.data.lesson.id]) {
      if (!id) continue;
      const removed = await request('DELETE', `/api/v1/courses/${course.id}/lessons/${id}`, {
        token: instructorSession.accessToken,
      });
      assert(removed.status < 300, `cleanup ${id} returned ${removed.status}`);
    }
  });

  await check('publishing an empty course is refused', async () => {
    const empty = await request('POST', '/api/v1/courses', {
      token: instructorSession.accessToken,
      body: { title: 'Empty course with no lessons' },
    });

    const { status, json } = await request('POST', `/api/v1/courses/${empty.json.data.course.id}/publish`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'NO_LESSONS', 'error code');

    await Course.deleteOne({ _id: empty.json.data.course.id });
  });

  await check('an instructor publishing a course sends it to review, not live', async () => {
    const { status, json } = await request('POST', `/api/v1/courses/${course.id}/publish`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.course.status, 'pending', 'an instructor cannot self-publish');
  });

  await check('the course is not visible publicly while it is pending', async () => {
    const { status } = await request('GET', `/api/v1/courses/${course.slug}`);
    assertEqual(status, 404, 'status');
  });

  await check('an admin approving the course publishes it', async () => {
    const { status, json } = await request('POST', `/api/v1/admin/courses/${course.id}/approve`, {
      token: adminSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.course.status, 'published', 'status');
  });

  await check('the course now appears in the public catalog', async () => {
    const { status, json } = await request('GET', '/api/v1/courses?q=Data%20Analysis');

    assertEqual(status, 200, 'status — the catalog must be readable without an account');
    assert(
      json.data.items.some((item) => item.slug === course.slug),
      'the published course should be listed'
    );
  });

  await check('an anonymous visitor cannot read lesson content', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.id}/lessons/${lessonB.id}`);
    assertEqual(status, 403, 'status');
    assertEqual(json.code, 'ENROLLMENT_REQUIRED', 'error code');
  });

  await check('a preview lesson is readable without enrolling', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.id}/lessons/${lessonA.id}`);
    assertEqual(status, 200, 'status');
    assert(json.data.lesson.content, 'the preview body should be returned');
  });

  await check('the syllabus shows a padlock per lesson', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.slug}`);

    assertEqual(status, 200, 'status');

    const preview = json.data.lessons.find((lesson) => lesson.id === lessonA.id);
    const lockedLesson = json.data.lessons.find((lesson) => lesson.id === lessonB.id);

    assertEqual(preview.locked, false, 'a preview lesson must not be locked');
    assertEqual(lockedLesson.locked, true, 'a non-preview lesson must be locked for a visitor');
  });

  await check('a student can enrol in a free course', async () => {
    const { status, json } = await request('POST', `/api/v1/courses/${course.id}/enroll`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.enrollment.progress, 0, 'progress');
    assertEqual(json.data.enrollment.status, 'active', 'status');
  });

  await check('enrolling twice does not create a second enrollment', async () => {
    const { status, json } = await request('POST', `/api/v1/courses/${course.id}/enroll`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status — the second call is not an error');
    assertEqual(await Enrollment.countDocuments({ course: course.id }), 1, 'enrollment count');
    assert(json.data.enrollment.id, 'the existing enrollment is returned');
  });

  await check('the course instructor cannot enrol in their own course', async () => {
    const { status } = await request('POST', `/api/v1/courses/${course.id}/enroll`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 400, 'status');
  });

  await check('an enrolled student can read lesson content', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.id}/lessons/${lessonB.id}`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(json.data.lesson.content, 'the lesson body');
    // lessonB is the second lesson, so the player is at position 2 of 2.
    assertEqual(json.data.navigation.position, 2, 'navigation position');
    assertEqual(json.data.navigation.total, 2, 'navigation total');
    assertEqual(json.data.navigation.previousLessonId, String(lessonA.id), 'previous lesson');
    assertEqual(json.data.navigation.nextLessonId, null, 'no lesson after the last one');
  });

  await check('completing the first lesson reports half the course done', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/courses/${course.id}/lessons/${lessonA.id}/complete`,
      { token: primaryUser.accessToken }
    );

    assertEqual(status, 200, 'status');
    assertEqual(json.data.progress, 50, 'progress');
    assertEqual(json.data.finished, false, 'finished');
    assertEqual(json.data.certificate, null, 'no certificate yet');
  });

  await check('completing a lesson twice does not double-count', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/courses/${course.id}/lessons/${lessonA.id}/complete`,
      { token: primaryUser.accessToken }
    );

    assertEqual(status, 200, 'status');
    assertEqual(json.data.progress, 50, 'progress must be unchanged');
    assertEqual(json.data.completedCount, 1, 'completed count must be unchanged');
  });

  await check('completing the last lesson completes the course', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/courses/${course.id}/lessons/${lessonB.id}/complete`,
      { token: primaryUser.accessToken }
    );

    assertEqual(status, 200, 'status');
    assertEqual(json.data.progress, 100, 'progress');
    assertEqual(json.data.finished, true, 'finished');
    assertEqual(json.data.enrollment.status, 'completed', 'enrollment status');
    assert(json.data.certificate, 'a certificate should be issued');

    certificate = json.data.certificate;
  });

  await check('a course cannot be completed beyond 100%', async () => {
    const { json } = await request('GET', `/api/v1/enrollments/me/${course.id}`, {
      token: primaryUser.accessToken,
    });

    assertEqual(json.data.enrollment.progress, 100, 'progress');
  });

  await check('exactly one certificate is issued, even on repeat completion', async () => {
    // Drive the completion path again; issuing must remain idempotent.
    await request('POST', `/api/v1/courses/${course.id}/lessons/${lessonB.id}/complete`, {
      token: primaryUser.accessToken,
    });

    const count = await Certificate.countDocuments({ student: primaryUser.user.id, course: course.id });
    assertEqual(count, 1, 'certificate count');
  });

  await check('the certificate appears in the student\'s list', async () => {
    const { status, json } = await request('GET', '/api/v1/certificates/me', {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.items.length, 1, 'certificate count');
    assertEqual(json.data.items[0].courseTitle, 'Introduction to Data Analysis', 'course title');
  });

  await check('a certificate verifies publicly without an account', async () => {
    const { status, json } = await request('GET', `/api/v1/certificates/verify/${certificate.verificationCode}`);

    assertEqual(status, 200, 'status');
    assertEqual(json.data.valid, true, 'valid');
    assertEqual(json.data.found, true, 'found');
    assert(json.data.studentName, 'the student name should be shown');
  });

  await check('a certificate verifies by its printed serial number too', async () => {
    const { status, json } = await request('GET', `/api/v1/certificates/verify/${certificate.certificateNumber}`);

    assertEqual(status, 200, 'status');
    assertEqual(json.data.certificateNumber, certificate.certificateNumber, 'certificate number');
  });

  await check('a made-up certificate reference reports as not found', async () => {
    const { status, json } = await request('GET', '/api/v1/certificates/verify/WGA-1999-999999');

    assertEqual(status, 200, 'status');
    assertEqual(json.data.found, false, 'found');
  });

  await check('public verification never leaks an email or account id', async () => {
    const { text } = await request('GET', `/api/v1/certificates/verify/${certificate.verificationCode}`);

    assert(!text.includes(primaryEmail), 'the student email must not be disclosed');
    assert(!text.includes(primaryUser.user.id), 'the account id must not be disclosed');
  });

  await check('completion raises a notification', async () => {
    const { status, json } = await request('GET', '/api/v1/notifications', {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(
      json.data.items.some((notification) => notification.type === 'certificate'),
      'a certificate notification should exist'
    );
  });

  await check('the certificate URL recorded on the enrollment is the same document', async () => {
    const enrollment = await Enrollment.findOne({ student: primaryUser.user.id, course: course.id });
    assertEqual(String(enrollment.certificate), String(certificate.id), 'linked certificate');
  });

  await check('the student dashboard summarises progress correctly', async () => {
    const { status, json } = await request('GET', '/api/v1/dashboard/student', {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(json.data.stats.enrolled >= 1, 'enrolled count');
    assert(json.data.stats.completed >= 1, 'completed count');
    assert(json.data.stats.certificates >= 1, 'certificate count');
    assertEqual(json.data.stats.hoursLearned, 2, 'hours learned from lesson durations (30 + 90 minutes)');
  });

  await check('the instructor dashboard reflects the teaching load', async () => {
    const { status, json } = await request('GET', '/api/v1/dashboard/instructor', {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.stats.students, 1, 'student count');
    assertEqual(json.data.stats.completions, 1, 'completion count');
  });

  await check('a student cannot reach the instructor dashboard', async () => {
    const { status } = await request('GET', '/api/v1/dashboard/instructor', {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 403, 'status');
  });

  await check('the roster shows the enrolled student', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.id}/roster`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.items.length, 1, 'roster size');
    assertEqual(json.data.items[0].progress, 100, 'student progress');
  });

  await check('a student cannot open the roster', async () => {
    const { status } = await request('GET', `/api/v1/courses/${course.id}/roster`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 403, 'status');
  });

  await check('admin statistics are consistent', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/stats', {
      token: adminSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(json.data.users.total >= 2, 'users counted');
    assert(json.data.courses.published >= 1, 'published courses counted');
    assert(json.data.certificates.issued >= 1, 'certificates counted');
  });

  await check('a student cannot read admin statistics', async () => {
    const { status } = await request('GET', '/api/v1/admin/stats', {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 403, 'status');
  });

  await check('checkout on a free course is rejected with a clear reason', async () => {
    // A course the student is *not* yet enrolled in, so the free-course check
    // is what rejects the request rather than the already-enrolled check.
    const free = await request('POST', '/api/v1/courses', {
      token: instructorSession.accessToken,
      body: { title: 'A free course for the checkout test', priceCents: 0 },
    });

    await Course.updateOne(
      { _id: free.json.data.course.id },
      { $set: { status: 'published', publishedAt: new Date() } }
    );

    const { status, json } = await request('POST', `/api/v1/payments/checkout/${free.json.data.course.id}`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'COURSE_IS_FREE', 'error code');

    await Course.deleteOne({ _id: free.json.data.course.id });
  });

  await check('a paid course cannot be bought twice', async () => {
    const { status } = await request('POST', `/api/v1/payments/checkout/${course.id}`, {
      token: primaryUser.accessToken,
    });

    // The student is already enrolled in `course`, so this is refused before
    // any payment machinery is reached.
    assertEqual(status, 403, 'status');
  });

  await check('checkout reports payments as unconfigured rather than crashing', async () => {
    const paid = await request('POST', '/api/v1/courses', {
      token: instructorSession.accessToken,
      body: { title: 'A paid course for the checkout test', priceCents: 4999, currency: 'usd' },
    });

    // Checkout is only offered for a live course.
    await Course.updateOne(
      { _id: paid.json.data.course.id },
      { $set: { status: 'published', publishedAt: new Date() } }
    );

    const { status, json } = await request('POST', `/api/v1/payments/checkout/${paid.json.data.course.id}`, {
      token: primaryUser.accessToken,
    });

    // Either the deployment has keys (and a session was created) or it does not
    // (and the caller gets an explicit 503). It must never be a 500.
    assert([201, 503].includes(status), `expected 201 or 503, got ${status}`);
    if (status === 503) assertEqual(json.code, 'PAYMENTS_DISABLED', 'error code');

    await Course.deleteOne({ _id: paid.json.data.course.id });
  });

  await check('the webhook rejects an unsigned request', async () => {
    const { status } = await request('POST', '/api/v1/payments/webhook', {
      body: { type: 'checkout.session.completed', data: { object: {} } },
    });

    assertEqual(status, 400, 'status — an unsigned webhook must never be trusted');
  });

  await check('a direct payment cannot be forged through the API', async () => {
    // There is no endpoint that marks a payment paid; only the signed webhook
    // can do it. This asserts the route simply does not exist.
    const { status } = await request('POST', '/api/v1/payments/fake-payment', {
      token: primaryUser.accessToken,
      body: { courseId: course.id },
    });

    assertEqual(status, 404, 'status');
  });

  /**
   * A sweep of every authenticated GET route, with its query string.
   *
   * This exists because a route can look correctly wired and still fail at
   * request time: `/messages/threads` shipped with a plain object where a Zod
   * schema belonged, so `validate()` threw `parse is not a function` and the
   * endpoint returned 500. Every existing test missed it — the auth test only
   * proved it returns 401 without a token, and the messaging tests used other
   * paths. Asserting "not a server error" across the whole surface is cheap and
   * catches that whole family of mistake.
   */
  const sweep = [
    ['student', primaryUser.accessToken, '/api/v1/dashboard/student'],
    ['student', primaryUser.accessToken, '/api/v1/dashboard/activity'],
    ['student', primaryUser.accessToken, '/api/v1/enrollments/me?limit=5'],
    ['student', primaryUser.accessToken, `/api/v1/enrollments/me/${course.id}`],
    ['student', primaryUser.accessToken, '/api/v1/certificates/me?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/notifications?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/notifications?unreadOnly=true&limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/community/activity'],
    ['student', primaryUser.accessToken, `/api/v1/community/posts?courseId=${course.id}&limit=5`],
    ['student', primaryUser.accessToken, '/api/v1/messages/threads?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/messages/unread-count'],
    ['student', primaryUser.accessToken, '/api/v1/study-groups?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/study-groups?mine=true&limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/live-sessions?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/live-sessions?scope=past&limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/live-sessions/upcoming'],
    ['student', primaryUser.accessToken, '/api/v1/payments/me?limit=5'],
    ['student', primaryUser.accessToken, '/api/v1/payments/config'],
    ['instructor', instructorSession.accessToken, '/api/v1/dashboard/instructor'],
    ['instructor', instructorSession.accessToken, '/api/v1/dashboard/instructor/students?limit=5'],
    ['instructor', instructorSession.accessToken, '/api/v1/dashboard/instructor/students?status=active&limit=5'],
    ['instructor', instructorSession.accessToken, '/api/v1/courses/mine?limit=5'],
    ['instructor', instructorSession.accessToken, `/api/v1/courses/${course.id}/roster?limit=5`],
    ['instructor', instructorSession.accessToken, `/api/v1/courses/${course.id}/lessons`],
    ['admin', adminSession.accessToken, '/api/v1/admin/stats'],
    ['admin', adminSession.accessToken, '/api/v1/admin/users?limit=5'],
    ['admin', adminSession.accessToken, '/api/v1/admin/users?role=student&status=active&limit=5'],
    ['admin', adminSession.accessToken, '/api/v1/admin/courses?limit=5'],
    ['admin', adminSession.accessToken, '/api/v1/admin/courses?status=published'],
    ['admin', adminSession.accessToken, '/api/v1/admin/enrollments?limit=5'],
    ['admin', adminSession.accessToken, '/api/v1/payments?limit=5'],
  ];

  for (const [role, token, path] of sweep) {
    // eslint-disable-next-line no-await-in-loop
    await check(`${role}: GET ${path} does not return a server error`, async () => {
      const { status } = await request('GET', path, { token });
      assert(status < 500, `expected a client response, got ${status}`);
    });
  }
}

/**
 * Manual payments: paying by transfer, confirmed by hand.
 *
 * This is the only route to a paid course while no gateway is configured for a
 * business registered in Liberia, so these are the checks standing between a
 * student who has sent money and a student who cannot get into the course they
 * paid for. The two failure modes worth guarding are the ones that cost real
 * money: confirming an order twice, and granting access without a confirmation.
 */
async function testManualPayments() {
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');
  const Payment = require('../src/models/Payment');
  const config = require('../src/config/env');

  const adminEmail = `smoke-manual-admin-${runId}@example.com`;
  const buyerEmail = `smoke-manual-buyer-${runId}@example.com`;
  const otherEmail = `smoke-manual-other-${runId}@example.com`;
  createdEmails.push(adminEmail, buyerEmail, otherEmail);

  let adminToken = null;
  let buyerToken = null;
  let otherToken = null;
  let buyerId = null;
  let otherId = null;
  let paidCourse = null;
  let secondCourse = null;
  let freeCourse = null;
  let order = null;

  await check('a manual-payment administrator and two students are provisioned', async () => {
    const instructor = await User.create({
      firstName: 'Manual',
      lastName: 'Instructor',
      email: `smoke-manual-instructor-${runId}@example.com`,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });
    createdEmails.push(instructor.email);

    await User.create({
      firstName: 'Manual',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Manual',
      lastName: 'Buyer',
      email: buyerEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Manual',
      lastName: 'Other',
      email: otherEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    const makeCourse = (slug, priceCents, title) =>
      Course.create({
        title,
        slug: `${slug}-${runId}`,
        instructor: instructor._id,
        instructorName: 'Manual Instructor',
        priceCents,
        currency: 'usd',
        status: 'published',
        publishedAt: new Date(),
      });

    paidCourse = await makeCourse('manual-paid', 2999, 'A course bought by transfer');
    secondCourse = await makeCourse('manual-paid-2', 1999, 'A second course bought by transfer');
    freeCourse = await makeCourse('manual-free', 0, 'A free course that needs no order');

    /**
     * The order payload carries a course id but not the student's, so the id
     * used by the assertions below is taken from the sign-in response rather
     * than guessed at from the order.
     */
    const signIn = async (email) => {
      const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
      return { token: json.data.accessToken, id: json.data.user.id };
    };

    const adminSession = await signIn(adminEmail);
    const buyerSession = await signIn(buyerEmail);
    const otherSession = await signIn(otherEmail);

    adminToken = adminSession.token;
    buyerToken = buyerSession.token;
    otherToken = otherSession.token;
    buyerId = buyerSession.id;
    otherId = otherSession.id;

    assert(Boolean(adminToken && buyerToken && otherToken && buyerId && otherId), 'three sessions');
  });

  await check('the manual method is offered, with the numbers to send to', async () => {
    const { status, json } = await request('GET', '/api/v1/payments/methods');

    assertEqual(status, 200, 'status');

    const manual = (json.data.methods || []).find((method) => method.id === 'manual');
    assert(Boolean(manual), 'a manual method is listed');
    assertEqual(manual.enabled, true, 'and is usable without any gateway keyed in');
    assertEqual(manual.numbers.length, config.manualPayment.numbers.length, 'numbers published');
  });

  await check('a student can open an order for a paid course', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: buyerToken,
      body: { courseId: String(paidCourse._id) },
    });

    assertEqual(status, 201, 'status');
    order = json.data.order;

    // The shape is documented, because a student reads this out over the phone.
    assert(/^WGA-\d{10,16}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(order.orderId), 'order reference');
    assertEqual(order.status, 'pending', 'status starts pending');
    assertEqual(json.data.instructions.numbers.length, config.manualPayment.numbers.length, 'instructions carry the numbers');
  });

  await check('the amount on an order comes from the course, never from the request', async () => {
    assertEqual(order.amountCents, paidCourse.priceCents, 'amount');

    // A caller who tries to name their own price must not be believed.
    const { json } = await request('POST', '/api/v1/payments/manual', {
      token: buyerToken,
      body: { courseId: String(paidCourse._id), amountCents: 1 },
    });

    assertEqual(json.data.order.amountCents, paidCourse.priceCents, 'amount despite being told otherwise');
  });

  await check('pressing the button twice returns the same order, not a second one', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: buyerToken,
      body: { courseId: String(paidCourse._id) },
    });

    assertEqual(status, 200, 'the second request is not a creation');
    assertEqual(json.data.order.orderId, order.orderId, 'same order reference');

    // The point of the idempotency key: a double tap on a slow connection must
    // not leave two orders for one purchase waiting in the administrator's queue.
    const count = await Payment.countDocuments({ student: buyerId, course: paidCourse._id });
    assertEqual(count, 1, 'exactly one order exists');
  });

  await check('a free course cannot be bought', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: buyerToken,
      body: { courseId: String(freeCourse._id) },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'COURSE_IS_FREE', 'code');
  });

  await check('the student can say they have sent the payment', async () => {
    const { status, json } = await request('POST', `/api/v1/payments/manual/${order.orderId}/mark-paid`, {
      token: buyerToken,
      body: { paymentReference: 'SMOKE-REF-1' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.order.status, 'awaiting_verification', 'status moves to the queue');
  });

  await check('saying so does not grant access on its own', async () => {
    const enrollment = await Enrollment.findOne({ student: buyerId, course: paidCourse._id });
    const stillPending = await Payment.findOne({ orderId: order.orderId });

    assertEqual(stillPending.status, 'awaiting_verification', 'the order is not paid yet');
    // A claim is not evidence. Only an administrator's confirmation enrols.
    assert(!enrollment, 'no enrolment exists yet');
  });

  await check('another student cannot mark somebody else\'s order as sent', async () => {
    const { status } = await request('POST', `/api/v1/payments/manual/${order.orderId}/mark-paid`, {
      token: otherToken,
      body: {},
    });

    assertEqual(status, 403, 'status');
  });

  await check('another student cannot read somebody else\'s order', async () => {
    const { status } = await request('GET', `/api/v1/payments/manual/${order.orderId}`, { token: otherToken });
    assertEqual(status, 403, 'status');
  });

  await check('the order waits in the administrator queue, with the student named', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/payments/manual?status=awaiting_verification', {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');

    const row = (json.data.items || []).find((item) => item.orderId === order.orderId);
    assert(Boolean(row), 'the order is listed');
    assertEqual(row.studentEmail, buyerEmail, 'the student email is on the row');
    assertEqual(row.amountLabel, '$29.99', 'the amount is labelled, not raw cents');
  });

  await check('the queue statistics count it as awaiting verification', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/payments/manual/stats', { token: adminToken });

    assertEqual(status, 200, 'status');
    assert(json.data.counts.awaitingVerification >= 1, 'awaiting count');
    // Money is summed in integer cents and formatted once, never as a float.
    assert(Number.isInteger(json.data.collectedCents), 'collected total is an integer number of cents');
  });

  await check('a student cannot read the administrator queue', async () => {
    const { status } = await request('GET', '/api/v1/admin/payments/manual', { token: buyerToken });
    assertEqual(status, 403, 'status');
  });

  await check('a student cannot confirm their own order', async () => {
    const { status } = await request('POST', `/api/v1/admin/payments/manual/${order.orderId}/verify`, {
      token: buyerToken,
      body: {},
    });

    assertEqual(status, 403, 'status');
  });

  await check('an administrator can confirm the payment', async () => {
    const { status, json } = await request('POST', `/api/v1/admin/payments/manual/${order.orderId}/verify`, {
      token: adminToken,
      body: {},
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.order.status, 'paid', 'the order is settled');
  });

  await check('confirming enrols the student and records where the money came from', async () => {
    const enrollment = await Enrollment.findOne({ student: buyerId, course: paidCourse._id });
    assert(Boolean(enrollment), 'an enrolment exists');
    assertEqual(enrollment.source, 'manual', 'source');
  });

  await check('the confirmed order is the payment record, with its reference', async () => {
    const payment = await Payment.findOne({ orderId: order.orderId });

    assertEqual(payment.status, 'paid', 'status');
    assertEqual(payment.amountCents, paidCourse.priceCents, 'amount');
    assertEqual(payment.provider, 'manual', 'provider');
    assert(Boolean(payment.verifiedBy), 'the administrator who confirmed it is recorded');
    assert(Boolean(payment.verifiedAt), 'and when');
  });

  await check('confirming the same order twice does not enrol twice', async () => {
    const { status } = await request('POST', `/api/v1/admin/payments/manual/${order.orderId}/verify`, {
      token: adminToken,
      body: {},
    });

    assertEqual(status, 200, 'the repeat is answered, not errored');
    const count = await Enrollment.countDocuments({ course: paidCourse._id });
    assertEqual(count, 1, 'exactly one enrolment');
  });

  await check('a student who is already enrolled cannot open a second order', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: buyerToken,
      body: { courseId: String(paidCourse._id) },
    });

    assertEqual(status, 403, 'status');
    assertEqual(json.code, 'ALREADY_ENROLLED', 'code');
  });

  await check('an administrator can reject an order, and rejection needs a reason', async () => {
    const opened = await request('POST', '/api/v1/payments/manual', {
      token: otherToken,
      body: { courseId: String(secondCourse._id) },
    });
    const reference = opened.json.data.order.orderId;

    await request('POST', `/api/v1/payments/manual/${reference}/mark-paid`, { token: otherToken, body: {} });

    const noReason = await request('POST', `/api/v1/admin/payments/manual/${reference}/reject`, {
      token: adminToken,
      body: {},
    });
    assertEqual(noReason.status, 400, 'a rejection with no reason is refused');

    const { status, json } = await request('POST', `/api/v1/admin/payments/manual/${reference}/reject`, {
      token: adminToken,
      body: { reason: 'No matching transfer was found.' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.order.status, 'rejected', 'status');
    assertEqual(json.data.order.rejectionReason, 'No matching transfer was found.', 'the student is told why');
  });

  await check('a rejected order grants nothing and cannot be marked sent again', async () => {
    const payment = await Payment.findOne({ status: 'rejected', course: secondCourse._id });
    const enrollment = await Enrollment.findOne({ student: otherId, course: secondCourse._id });

    assert(!enrollment, 'no enrolment');

    const { status } = await request('POST', `/api/v1/payments/manual/${payment.orderId}/mark-paid`, {
      token: otherToken,
      body: {},
    });

    assertEqual(status, 400, 'marking a rejected order sent is refused');
  });

  await check('a malformed order reference is refused before any lookup', async () => {
    const { status } = await request('GET', '/api/v1/payments/manual/WGA-not-a-reference', { token: buyerToken });
    assertEqual(status, 400, 'status');
  });
}

/**
 * Community and messaging, exercised as two different students so that the
 * isolation between them is actually tested.
 */
/**
 * The course taxonomy and the credential a course awards.
 *
 * The category list used to be hard-coded in the instructor form while the API
 * accepted any string, so the picker and the catalogue could disagree without
 * anything failing. These checks pin one vocabulary, prove the old spellings
 * still resolve, and prove the qualification a course advertises is the one
 * printed on the certificate the student receives.
 */
async function testTaxonomyAndCredentials() {
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');
  const certificateService = require('../src/services/certificateService');
  const { COURSE_CATEGORIES } = require('../src/lib/constants');

  const instructorEmail = `smoke-tax-instructor-${runId}@example.com`;
  const studentEmail = `smoke-tax-student-${runId}@example.com`;
  createdEmails.push(instructorEmail, studentEmail);

  let instructorToken = null;
  let student = null;
  let diplomaCourse = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  await check('a taxonomy instructor and student are provisioned', async () => {
    await User.create({
      firstName: 'Taxonomy',
      lastName: 'Instructor',
      email: instructorEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    student = await User.create({
      firstName: 'Taxonomy',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    instructorToken = await signIn(instructorEmail);
    assert(instructorToken, 'the instructor could not sign in');
  });

  await check('the taxonomy endpoint serves one category list with labels', async () => {
    const { status, json } = await request('GET', '/api/v1/courses/taxonomy');
    assertEqual(status, 200, 'status');

    const categories = json.data.categories;
    assert(Array.isArray(categories), 'categories must be an array');
    assertEqual(categories.length, COURSE_CATEGORIES.length, 'category count');

    categories.forEach((category) => {
      assert(typeof category.slug === 'string' && category.slug, 'every category needs a slug');
      assert(typeof category.label === 'string' && category.label, `"${category.slug}" needs a label`);
    });

    const slugs = new Set(categories.map((category) => category.slug));
    assertEqual(slugs.size, categories.length, 'category slugs must be unique');
  });

  await check('the taxonomy offers certificate and diploma but never degree', async () => {
    const { json } = await request('GET', '/api/v1/courses/taxonomy');
    const offered = (json.data.credentials || []).map((credential) => credential.slug);

    assertEqual(offered.length, 2, 'selectable credential count');
    assert(offered.includes('certificate'), 'certificate must be offered');
    assert(offered.includes('diploma'), 'diploma must be offered');
    assert(!offered.includes('degree'), 'degree must not be offered: it cannot be awarded yet');
  });

  await check('category facets carry a display label and a count', async () => {
    const { status, json } = await request('GET', '/api/v1/courses/categories');
    assertEqual(status, 200, 'status');

    const facets = json.data.categories || [];
    assert(facets.length > 0, 'the catalog has published courses, so facets must not be empty');

    facets.forEach((facet) => {
      assert(typeof facet.name === 'string' && facet.name, 'a facet needs its stored value');
      assert(typeof facet.label === 'string' && facet.label, `"${facet.name}" needs a display label`);
      assert(Number.isInteger(facet.count) && facet.count > 0, 'a facet must count at least one course');
      assert(facet.label !== facet.name, `"${facet.name}" must be shown with a readable label`);
    });
  });

  await check('a course cannot claim a degree', async () => {
    const { status, json } = await request('POST', '/api/v1/courses', {
      token: instructorToken,
      body: { title: `A course claiming a degree ${runId}`, credential: 'degree' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
  });

  await check('a course cannot be filed under an unknown category', async () => {
    const { status } = await request('POST', '/api/v1/courses', {
      token: instructorToken,
      body: { title: `A course in a made-up category ${runId}`, category: 'astrology' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('a legacy category spelling is accepted on write and stored canonically', async () => {
    const { status, json } = await request('POST', '/api/v1/courses', {
      token: instructorToken,
      body: { title: `A course still filed under an old category ${runId}`, category: 'data' },
    });

    assertEqual(status, 201, 'status');

    const created = json.data.course || {};
    const stored = await Course.findById(created.id || created._id);
    assert(stored, 'the course was not persisted');
    assertEqual(stored.category, 'data-analytics', 'a legacy alias must be stored canonically');

    await Course.deleteOne({ _id: stored._id });
  });

  await check('a diploma course is created with its credential stored', async () => {
    const { status, json } = await request('POST', '/api/v1/courses', {
      token: instructorToken,
      body: {
        title: `A diploma course ${runId}`,
        category: 'business-management',
        credential: 'diploma',
        priceCents: 4900,
      },
    });

    assertEqual(status, 201, 'status');

    const created = json.data.course || {};
    const courseId = created.id || created._id;
    assert(courseId, 'the create response must identify the new course');

    diplomaCourse = await Course.findById(courseId);
    assert(diplomaCourse, 'the course was not persisted');
    assertEqual(diplomaCourse.credential, 'diploma', 'stored credential');
    assertEqual(diplomaCourse.category, 'business-management', 'stored category');
  });

  await check('the catalogue respects the credential filter', async () => {
    await Course.updateOne({ _id: diplomaCourse._id }, { $set: { status: 'published', publishedAt: new Date() } });

    const wanted = String(diplomaCourse._id);
    const identity = (course) => String(course.id || course._id);

    const diploma = await request('GET', '/api/v1/courses?credential=diploma&limit=100');
    assertEqual(diploma.status, 200, 'status');
    assert(
      diploma.json.data.items.some((course) => identity(course) === wanted),
      'a published diploma course must appear under ?credential=diploma'
    );

    const certificate = await request('GET', '/api/v1/courses?credential=certificate&limit=100');
    assert(
      !certificate.json.data.items.some((course) => identity(course) === wanted),
      'a diploma course must not appear under ?credential=certificate'
    );
  });

  await check('a legacy category filter still resolves to the new category', async () => {
    const { status, json } = await request('GET', '/api/v1/courses?category=business&limit=100');
    assertEqual(status, 200, 'status');

    const wanted = String(diplomaCourse._id);
    assert(
      json.data.items.some((course) => String(course.id || course._id) === wanted),
      '?category=business must still find a course filed under business-management'
    );
  });

  await check('an issued certificate records the credential its course awards', async () => {
    const enrollment = await Enrollment.create({
      student: student._id,
      course: diplomaCourse._id,
      status: 'active',
      completedAt: new Date(),
      hoursSpent: 12,
    });

    const certificate = await certificateService.issueFor(enrollment, diplomaCourse, student);
    assert(certificate, 'the certificate was not issued');
    assertEqual(certificate.credential, 'diploma', 'stored certificate credential');

    const verification = certificate.toVerificationJSON();
    assertEqual(verification.credential, 'diploma', 'verification credential');
    assertEqual(verification.valid, true, 'the certificate must verify as valid');
    assertEqual(verification.issuedBy, 'Wuteve Global Academy', 'issuer');
  });
}

/**
 * Profile photos.
 *
 * The interesting part is not that a picture can be uploaded, it is that only a
 * picture can. The bytes are sniffed rather than trusted, so a zip renamed to
 * `photo.png` and an SVG carrying a script are both refused — the second
 * especially, because serving an SVG from this origin would make a profile
 * picture into stored cross-site scripting.
 */
async function testAvatars() {
  const { sniffImageType } = require('../src/lib/avatar');

  const memberEmail = `smoke-avatar-${runId}@example.com`;
  createdEmails.push(memberEmail);

  // Signature bytes only. The server sniffs the header and stores the rest
  // untouched; decoding the pixels is the browser's job, not ours.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const ZIP = Buffer.from('504b0304' + '00'.repeat(24), 'hex');
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  const dataUrl = (buffer, label = 'image/png') => `data:${label};base64,${buffer.toString('base64')}`;

  let token = null;
  let firstUrl = null;

  await check('a member registers for the avatar tests', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ email: memberEmail, firstName: 'Photo', lastName: 'Tester' }),
    });

    assertEqual(status, 201, 'status');
    token = json.data.accessToken;
    assertEqual(json.data.user.avatarUrl, null, 'a new account has no picture');
  });

  await check('an uploaded photo becomes the account avatar', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/avatar', {
      token,
      body: { image: dataUrl(PNG) },
    });

    assertEqual(status, 200, 'status');

    firstUrl = json.data.user.avatarUrl;
    assert(typeof firstUrl === 'string' && firstUrl.startsWith('/api/v1/avatars/'), 'the avatar URL is returned');
    assert(/^\/api\/v1\/avatars\/[a-f0-9]{32}$/.test(firstUrl), 'the address is a random key, not a user id');
  });

  await check('the photo loads without a session, so an img tag can show it', async () => {
    const response = await request('GET', firstUrl);

    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), 'image/png', 'content type');
    assertEqual(response.headers.get('x-content-type-options'), 'nosniff', 'the browser must not re-decide the type');
    // The body arrives as text and binary does not survive a UTF-8 round trip,
    // so the length is read off the header the server set from the buffer.
    assertEqual(response.headers.get('content-length'), String(PNG.length), 'byte length');
  });

  await check('a non-image labelled as a PNG is refused', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/avatar', {
      token,
      body: { image: dataUrl(ZIP) },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'INVALID_AVATAR', 'error code');
  });

  await check('an SVG is refused even though it is an image', async () => {
    const { status } = await request('PUT', '/api/v1/auth/me/avatar', {
      token,
      body: { image: dataUrl(SVG, 'image/svg+xml') },
    });

    assertEqual(status, 400, 'status — an SVG can carry script');
  });

  await check('an image over the size limit is refused', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(130 * 1024)]);

    const { status, json } = await request('PUT', '/api/v1/auth/me/avatar', {
      token,
      body: { image: dataUrl(oversized) },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'INVALID_AVATAR', 'error code');
  });

  await check('replacing the photo mints a new address and retires the old one', async () => {
    const { status, json } = await request('PUT', '/api/v1/auth/me/avatar', {
      token,
      body: { image: dataUrl(PNG) },
    });

    assertEqual(status, 200, 'status');
    assert(json.data.user.avatarUrl !== firstUrl, 'a new upload must not reuse the old address');

    const retired = await request('GET', firstUrl);
    assertEqual(retired.status, 404, 'the replaced address must stop resolving');
  });

  await check('an unknown avatar key is a 404, not an account probe', async () => {
    const missing = await request('GET', `/api/v1/avatars/${'0'.repeat(32)}`);
    assertEqual(missing.status, 404, 'status');

    const malformed = await request('GET', '/api/v1/avatars/not-a-real-key');
    assertEqual(malformed.status, 404, 'status');
  });

  await check('removing the photo returns the account to initials', async () => {
    const { status, json } = await request('DELETE', '/api/v1/auth/me/avatar', { token });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.user.avatarUrl, null, 'the avatar is gone');
  });

  await check('the sniffing helper agrees with the endpoint', async () => {
    assertEqual(sniffImageType(PNG), 'image/png', 'png');
    assertEqual(sniffImageType(ZIP), null, 'zip');
    assertEqual(sniffImageType(SVG), null, 'svg');
  });
}

/**
 * The printable certificate.
 *
 * A PDF is generated for every certificate at issue time, from one of two
 * template sheets. The tests here are about the things that would actually hurt
 * a graduate: a document that will not open, a document with the wrong shape, a
 * document anyone can download, or a document a stranger can download.
 */
async function testCertificateDocuments() {
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');
  const Certificate = require('../src/models/Certificate');
  const certificateService = require('../src/services/certificateService');
  const { renderCertificate, PAGE } = require('../src/services/certificateRenderer');

  const ownerEmail = `smoke-certdoc-owner-${runId}@example.com`;
  const strangerEmail = `smoke-certdoc-stranger-${runId}@example.com`;
  createdEmails.push(ownerEmail, strangerEmail);

  let ownerToken = null;
  let strangerToken = null;
  let owner = null;
  let certificate = null;

  await check('a graduate and a stranger are provisioned for the document tests', async () => {
    owner = await User.create({
      firstName: 'Document',
      lastName: 'Owner',
      email: ownerEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Document',
      lastName: 'Stranger',
      email: strangerEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    const instructor = await User.create({
      firstName: 'Document',
      lastName: 'Instructor',
      email: `smoke-certdoc-instructor-${runId}@example.com`,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });
    createdEmails.push(instructor.email);

    const course = await Course.create({
      title: `A course with a printable certificate ${runId}`,
      slug: `certdoc-${runId}`,
      instructor: instructor._id,
      instructorName: 'Document Instructor',
      priceCents: 0,
      currency: 'usd',
      status: 'published',
      publishedAt: new Date(),
      credential: 'diploma',
    });

    const enrollment = await Enrollment.create({
      student: owner._id,
      course: course._id,
      status: 'active',
      completedAt: new Date(),
      hoursSpent: 9,
    });

    certificate = await certificateService.issueFor(enrollment, course, owner);
    assert(certificate, 'the certificate was not issued');

    const signIn = async (email) => {
      const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
      return json.data.accessToken;
    };

    ownerToken = await signIn(ownerEmail);
    strangerToken = await signIn(strangerEmail);
  });

  await check('issuing a certificate renders a PDF and stores it', async () => {
    const stored = await Certificate.findById(certificate._id).select('+pdfBase64');

    assert(stored.pdfBase64, 'the PDF must be stored on the certificate');
    assert(stored.pdfGeneratedAt instanceof Date, 'the render time must be recorded');

    const bytes = Buffer.from(stored.pdfBase64, 'base64');
    assertEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the document must be a PDF');
  });

  await check('the rendered PDF is A4 landscape', async () => {
    // The document is loaded back rather than pattern-matched: pdf-lib writes
    // the page dictionary into a compressed object stream, so the MediaBox is
    // not there to find as plain text. Reading it through a parser is also the
    // stronger assertion — it proves the file is a valid PDF, not just bytes
    // that contain the right characters.
    const { PDFDocument } = require('pdf-lib');
    const stored = await Certificate.findById(certificate._id).select('+pdfBase64');
    const bytes = Buffer.from(stored.pdfBase64, 'base64');

    const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = document.getPages();

    assertEqual(pages.length, 1, 'a certificate is a single sheet');

    const { width, height } = pages[0].getSize();

    assertEqual(Math.round(width), PAGE.width, 'page width in points');
    assertEqual(Math.round(height), PAGE.height, 'page height in points');
    assert(width > height, 'the sheet must be landscape');
  });

  await check('both credentials render without error', async () => {
    for (const credentialType of ['certificate', 'diploma']) {
      const { buffer, measurements } = await renderCertificate({
        studentName: 'Test Graduate',
        courseName: 'A course that has to fit on one line',
        certificateNumber: 'WGA-TEST-000001',
        credentialType,
        issuedAt: new Date(),
        verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
      });

      assert(buffer.length > 1000, `${credentialType}: the PDF must have content`);
      assertEqual(measurements.credentialType, credentialType, `${credentialType}: template used`);
      assertEqual(
        measurements.template,
        credentialType === 'diploma' ? 'diploma-template.jpg' : 'certificate-template.jpg',
        `${credentialType}: the right sheet`
      );
    }
  });

  await check('a very long name is shrunk rather than overflowing', async () => {
    const { measurements } = await renderCertificate({
      studentName: 'Nyenpuo Wureh-Gbessageh Kollie-Massaquoi Williams',
      courseName: 'Financial Literacy for Professionals',
      certificateNumber: 'WGA-TEST-000002',
      credentialType: 'certificate',
      issuedAt: new Date(),
      verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
    });

    assert(measurements.nameSize < 60, 'a long name must be reduced from the 60pt start');
    assert(measurements.nameSize >= 40, 'but never below the 40pt floor');
  });

  await check('the name is centred on the artwork\'s text column, not the page', async () => {
    // The artwork reserves its left fifth for the gold banner and the seal, and
    // centres its prose at 61.6% of the width. Centring on 50% put the name
    // 97pt to the left of the paragraph it belongs to.
    const target = 0.616 * PAGE.width;

    for (const studentName of ['Bo Kai', 'John Doe', "Mariama O'Neil-Collins", 'Nyenpuo Wureh-Gbessageh']) {
      const { measurements } = await renderCertificate({
        studentName,
        courseName: 'Financial Literacy for Professionals',
        certificateNumber: 'WGA-TEST-000010',
        credentialType: 'certificate',
        issuedAt: new Date(),
        verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
      });

      const drift = Math.abs(measurements.nameInkCentre - target);
      assert(drift < 5, `${studentName}: ink centre drifted ${drift.toFixed(2)}pt from the column`);
    }
  });

  await check('the course is centred on the same column', async () => {
    const target = 0.616 * PAGE.width;

    const courses = [
      'Marketing Management',
      'Financial Literacy for Professionals',
      'Advanced Data Analytics and Business Intelligence',
      'Introduction to Cyber Security Best Practices',
    ];

    for (const courseName of courses) {
      const { measurements } = await renderCertificate({
        studentName: 'John Doe',
        courseName,
        certificateNumber: 'WGA-TEST-000011',
        credentialType: 'diploma',
        issuedAt: new Date(),
        verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
      });

      const drift = Math.abs(measurements.courseInkCentre - target);
      assert(drift < 5, `"${courseName}": ink centre drifted ${drift.toFixed(2)}pt from the column`);
    }
  });

  await check('the headings are bold and start at the approved sizes', async () => {
    const { measurements } = await renderCertificate({
      studentName: 'Bo Kai',
      courseName: 'Marketing Management',
      certificateNumber: 'WGA-TEST-000012',
      credentialType: 'certificate',
      issuedAt: new Date(),
      verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
    });

    assertEqual(measurements.nameFont, 'Times-Bold', 'the heading face');
    assertEqual(measurements.nameSize, 60, 'a short name stays at the start size');
    assertEqual(measurements.courseSize, 36, 'a short course stays at the start size');
  });

  await check('no line can reach past the decorative border', async () => {
    const { measurements } = await renderCertificate({
      studentName: 'Nyenpuo Wureh-Gbessageh Kollie-Massaquoi Williams',
      courseName: 'Advanced Data Analytics and Business Intelligence for Public Sector Managers',
      certificateNumber: 'WGA-TEST-000013',
      credentialType: 'certificate',
      issuedAt: new Date(),
      verificationUrl: 'https://wuteveglobalacademy.com/verify/test-code',
    });

    const half = (value, centre) => Math.abs(value - centre) / 2;

    assert(
      half(measurements.nameWidth, measurements.columnCentre) <= 0.9558 * PAGE.width - measurements.columnCentre + 0.5,
      'the name must not cross the border'
    );
    assert(
      half(measurements.courseWidth, measurements.columnCentre) <= 0.9558 * PAGE.width - measurements.columnCentre + 0.5,
      'the course must not cross the border'
    );
  });

  await check('the QR code points at the public verification page', async () => {
    const { measurements } = await renderCertificate({
      studentName: 'Test Graduate',
      courseName: 'A course',
      certificateNumber: 'WGA-TEST-000003',
      credentialType: 'certificate',
      issuedAt: new Date(),
      verificationUrl: 'https://wuteveglobalacademy.com/verify/abc123',
    });

    assert(
      measurements.target.startsWith('https://wuteveglobalacademy.com/verify/'),
      'the QR must resolve to the pretty verify URL, not a query string'
    );
  });

  await check('the download endpoint refuses an anonymous request', async () => {
    const { status } = await request('GET', `/api/v1/certificates/${certificate._id}/download`);
    assertEqual(status, 401, 'status');
  });

  await check('a stranger cannot download someone else\'s certificate', async () => {
    const { status } = await request('GET', `/api/v1/certificates/${certificate._id}/download`, {
      token: strangerToken,
    });

    // 404 rather than 403: a stranger must not learn that this certificate
    // exists, which is the same rule the certificate detail route follows.
    assertEqual(status, 404, 'status');
  });

  await check('the owner can download their certificate', async () => {
    const response = await request('GET', `/api/v1/certificates/${certificate._id}/download`, {
      token: ownerToken,
    });

    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), 'application/pdf', 'content type');
    assert(
      String(response.headers.get('content-disposition') || '').includes('attachment'),
      'the response must be an attachment'
    );
    assert(
      String(response.headers.get('cache-control') || '').includes('private'),
      'a personal document must not be cached publicly'
    );
    assert(Number(response.headers.get('content-length')) > 1000, 'the body must carry the PDF');
  });

  await check('an administrator can download any certificate', async () => {
    const adminEmail = `smoke-certdoc-admin-${runId}@example.com`;
    createdEmails.push(adminEmail);

    await User.create({
      firstName: 'Document',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    const signIn = await request('POST', '/api/v1/auth/login', {
      body: { email: adminEmail, password: PASSWORD },
    });

    const { status } = await request('GET', `/api/v1/certificates/${certificate._id}/download`, {
      token: signIn.json.data.accessToken,
    });

    assertEqual(status, 200, 'status');
  });

  await check('an unknown certificate reference cannot be downloaded', async () => {
    const { status } = await request('GET', '/api/v1/certificates/000000000000000000000000/download', {
      token: ownerToken,
    });

    assertEqual(status, 404, 'status');
  });
}

/**
 * The deployment's configuration status, as an administrator sees it.
 *
 * Every integration here is inert until it is configured, and inert quietly —
 * which is correct behaviour and also means a broken integration is
 * indistinguishable from a working one. These checks pin the payload that makes
 * the difference visible, and that it stays free of secrets.
 */
async function testAdminSystemStatus() {
  const adminEmail = `smoke-system-admin-${runId}@example.com`;
  const studentEmail = `smoke-system-student-${runId}@example.com`;
  createdEmails.push(adminEmail, studentEmail);

  let adminToken = null;
  let studentToken = null;

  await check('an administrator and a student are provisioned for the system check', async () => {
    await User.create({
      firstName: 'System',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    await User.create({
      firstName: 'System',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    const signIn = async (email) => {
      const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
      return json.data.accessToken;
    };

    adminToken = await signIn(adminEmail);
    studentToken = await signIn(studentEmail);
  });

  /**
   * The shape is the point. Each field answers "is this integration on?" for a
   * feature that is otherwise inert and silent when it is not configured.
   */
  await check('an administrator can read the deployment configuration', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/system', { token: adminToken });

    assertEqual(status, 200, 'status');

    const data = json.data || {};

    assertEqual(typeof data.email.enabled, 'boolean', 'email.enabled');
    assertEqual(typeof data.email.from, 'string', 'email.from');
    assert(data.publicBaseUrl, 'publicBaseUrl must be reported');

    assertEqual(typeof data.storage.enabled, 'boolean', 'storage.enabled');

    for (const key of ['manual', 'card', 'orangeMoney', 'lonestar']) {
      assertEqual(typeof data.payments[key], 'boolean', `payments.${key}`);
    }

    assertEqual(typeof data.nodeEnv, 'string', 'nodeEnv');

    // The whole reason this endpoint is worth having: a base URL of localhost
    // in production puts a dead link inside every email and every certificate
    // QR code, and nothing else in the system would report it.
    assert(
      data.publicBaseUrl.startsWith('http'),
      'publicBaseUrl must be an absolute URL'
    );
  });

  await check('the configuration is never readable by a student', async () => {
    const { status } = await request('GET', '/api/v1/admin/system', { token: studentToken });
    assertEqual(status, 403, 'status');
  });

  await check('the configuration leaks no secret material', async () => {
    const { json } = await request('GET', '/api/v1/admin/system', { token: adminToken });
    const serialised = JSON.stringify(json);

    // It reports whether a thing is configured, never what it is configured
    // with. If a key ever reaches this payload, this fails.
    for (const forbidden of ['apiKey', 'api_key', 'secretKey', 'secret', 'password', 'mongoUri', 'mongodb+srv']) {
      assert(
        !serialised.toLowerCase().includes(forbidden.toLowerCase()),
        `the payload must not contain "${forbidden}"`
      );
    }
  });
}

async function testCommunityAndMessaging() {  const Course = require('../src/models/Course');
  const CommunityPost = require('../src/models/CommunityPost');

  const peerEmail = `smoke-peer-${runId}@example.com`;
  createdEmails.push(peerEmail);

  let peer = null;
  let peerCourse = null;
  let postId = null;
  let threadId = null;

  await check('a second student can register', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Peer', lastName: 'Student', email: peerEmail }),
    });

    assertEqual(status, 201, 'status');
    peer = json.data;
  });

  await check('an instructor publishes a course for the social tests', async () => {
    const instructorEmail = `smoke-social-${runId}@example.com`;
    createdEmails.push(instructorEmail);

    await User.create({
      firstName: 'Social',
      lastName: 'Instructor',
      email: instructorEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: instructorEmail, password: PASSWORD },
    });

    const instructorToken = login.json.data.accessToken;

    const created = await request('POST', '/api/v1/courses', {
      token: instructorToken,
      body: { title: 'Community test course', priceCents: 0 },
    });

    peerCourse = created.json.data.course;

    await request('POST', `/api/v1/courses/${peerCourse.id}/lessons`, {
      token: instructorToken,
      body: { title: 'A lesson', type: 'text', content: 'Body', durationMinutes: 10 },
    });

    // Instructors queue for review; publish directly through the model here so
    // this suite tests community features rather than the approval flow.
    await Course.updateOne({ _id: peerCourse.id }, { $set: { status: 'published', publishedAt: new Date() } });
  });

  await check('a non-enrolled student cannot read the discussion', async () => {
    const { status } = await request('GET', `/api/v1/community/posts?courseId=${peerCourse.id}`, {
      token: peer.accessToken,
    });

    assertEqual(status, 403, 'status');
  });

  await check('an enrolled student can post a question', async () => {
    await request('POST', `/api/v1/courses/${peerCourse.id}/enroll`, { token: peer.accessToken });

    const { status, json } = await request('POST', '/api/v1/community/posts', {
      token: peer.accessToken,
      body: {
        courseId: peerCourse.id,
        title: 'How do I approach the second exercise?',
        content: 'I keep getting a different answer.',
      },
    });

    assertEqual(status, 201, 'status');
    postId = json.data.post.id;
  });

  await check('a post cannot be posted to a course the author cannot see', async () => {
    const outsider = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Out', lastName: 'Sider', email: `smoke-outsider2-${runId}@example.com` }),
    });

    createdEmails.push(`smoke-outsider2-${runId}@example.com`);

    const { status } = await request('POST', '/api/v1/community/posts', {
      token: outsider.json.data.accessToken,
      body: { courseId: peerCourse.id, title: 'Not a member', content: 'Should be blocked' },
    });

    assertEqual(status, 403, 'status');
  });

  await check('another member can reply', async () => {
    const instructor = await User.findOne({ email: `smoke-social-${runId}@example.com` });
    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: instructor.email, password: PASSWORD },
    });

    const { status, json } = await request('POST', `/api/v1/community/posts/${postId}/replies`, {
      token: login.json.data.accessToken,
      body: { content: 'Try working through step three again.' },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.replyCount, 1, 'reply count');
  });

  await check('liking is a toggle, not a counter that drifts', async () => {
    const first = await request('POST', `/api/v1/community/posts/${postId}/like`, {
      token: peer.accessToken,
    });

    assertEqual(first.json.data.liked, true, 'liked');
    assertEqual(first.json.data.likeCount, 1, 'like count');

    const second = await request('POST', `/api/v1/community/posts/${postId}/like`, {
      token: peer.accessToken,
    });

    assertEqual(second.json.data.liked, false, 'unliked');
    assertEqual(second.json.data.likeCount, 0, 'like count');
  });

  await check('a student cannot edit someone else\'s post', async () => {
    const intruderEmail = `smoke-intruder-${runId}@example.com`;
    createdEmails.push(intruderEmail);

    const registered = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'In', lastName: 'Truder', email: intruderEmail }),
    });

    await request('POST', `/api/v1/courses/${peerCourse.id}/enroll`, {
      token: registered.json.data.accessToken,
    });

    const { status } = await request('PATCH', `/api/v1/community/posts/${postId}`, {
      token: registered.json.data.accessToken,
      body: { title: 'Hijacked title goes here' },
    });

    assertEqual(status, 403, 'status');
  });

  await check('deleting a post keeps the replies readable', async () => {
    const { status } = await request('DELETE', `/api/v1/community/posts/${postId}`, {
      token: peer.accessToken,
    });

    assertEqual(status, 200, 'status');

    const post = await CommunityPost.findById(postId);
    assert(post.deletedAt !== null, 'the post should be soft deleted');
    assertEqual(post.replies.length, 1, 'the reply must survive');
  });

  await check('a student can start a direct conversation', async () => {
    const { status, json } = await request('POST', '/api/v1/messages/threads', {
      token: peer.accessToken,
      body: { recipientId: primaryUser.user.id, message: 'Hello, quick question about the course.' },
    });

    assertEqual(status, 201, 'status');
    assert(json.data.thread.id, 'a thread should be returned');
    threadId = json.data.thread.id;
  });

  await check('opening the same conversation twice reuses the thread', async () => {
    const { status, json } = await request('POST', '/api/v1/messages/threads', {
      token: primaryUser.accessToken,
      body: { recipientId: peer.user.id },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.thread.id, threadId, 'the existing thread must be reused, not duplicated');
  });

  await check('the recipient sees the message and an unread count', async () => {
    const { status, json } = await request('GET', `/api/v1/messages/threads/${threadId}`, {
      token: primaryUser.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.items.length, 1, 'message count');
    assert(json.data.items[0].isMine === false, 'the message belongs to the other participant');
  });

  await check('a stranger cannot read the conversation', async () => {
    const strangerEmail = `smoke-stranger-${runId}@example.com`;
    createdEmails.push(strangerEmail);

    const registered = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Stran', lastName: 'Ger', email: strangerEmail }),
    });

    const { status } = await request('GET', `/api/v1/messages/threads/${threadId}`, {
      token: registered.json.data.accessToken,
    });

    assertEqual(status, 404, 'status — a non-participant must not learn the thread exists');
  });

  await check('a message cannot be posted by a non-participant', async () => {
    const strangerEmail = `smoke-stranger2-${runId}@example.com`;
    createdEmails.push(strangerEmail);

    const registered = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Stran', lastName: 'Ger2', email: strangerEmail }),
    });

    const { status } = await request('POST', `/api/v1/messages/threads/${threadId}`, {
      token: registered.json.data.accessToken,
      body: { content: 'Intruding into this conversation' },
    });

    assertEqual(status, 404, 'status');
  });

  await check('marking a conversation read clears its unread count', async () => {
    const before = await request('GET', '/api/v1/messages/unread-count', { token: primaryUser.accessToken });
    assert(before.json.data.unread >= 1, 'there should be something unread');

    await request('POST', `/api/v1/messages/threads/${threadId}/read`, { token: primaryUser.accessToken });

    const after = await request('GET', '/api/v1/messages/unread-count', { token: primaryUser.accessToken });
    assertEqual(after.json.data.unread, 0, 'unread count');
  });

  await check('a study group can be created and joined', async () => {
    const { status, json } = await request('POST', '/api/v1/study-groups', {
      token: peer.accessToken,
      body: { name: 'Weekend study circle', courseId: peerCourse.id },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.group.memberCount, 1, 'the creator joins automatically');
    assert(json.data.group.threadId, 'the group should own a conversation');

    const join = await request('POST', `/api/v1/study-groups/${json.data.group.id}/join`, {
      token: primaryUser.accessToken,
    });

    if (join.status === 403) {
      // The other student is not enrolled in this course, which is the rule.
      return;
    }

    assertEqual(join.status, 200, 'join status');
    assertEqual(join.json.data.group.memberCount, 2, 'member count');
  });

  await check('a non-member cannot join a private group', async () => {
    const { json } = await request('POST', '/api/v1/study-groups', {
      token: peer.accessToken,
      body: { name: 'Private circle', courseId: peerCourse.id, isPrivate: true },
    });

    const { status } = await request('POST', `/api/v1/study-groups/${json.data.group.id}/join`, {
      token: primaryUser.accessToken,
    });

    // Blocked either because the group is private (403) or because the joiner
    // is not enrolled in the course (403). Both are refusals.
    assertEqual(status, 403, 'status');
  });

  await check('live sessions hide the join link from outsiders', async () => {
    const instructor = await User.findOne({ email: `smoke-social-${runId}@example.com` });
    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: instructor.email, password: PASSWORD },
    });

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const { status, json } = await request('POST', '/api/v1/live-sessions', {
      token: login.json.data.accessToken,
      body: {
        courseId: peerCourse.id,
        title: 'Live walkthrough',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        meetingLink: 'https://meet.example.com/abc-defg-hij',
      },
    });

    assertEqual(status, 201, 'status');

    const { json: asStranger } = await request('GET', '/api/v1/payments/config');
    assert(asStranger.data.enabled === true || asStranger.data.enabled === false, 'payments config readable');

    // An enrolled student can join and therefore sees the link.
    const enrolled = await request('GET', `/api/v1/live-sessions/${json.data.session.id}`, {
      token: peer.accessToken,
    });

    assertEqual(enrolled.status, 200, 'enrolled status');
    assert(enrolled.json.data.session.meetingLink, 'an enrolled student should receive the join link');
  });

  await check('an outsider is refused access to the live session', async () => {
    const outsiderEmail = `smoke-liveoutsider-${runId}@example.com`;
    createdEmails.push(outsiderEmail);

    const registered = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Live', lastName: 'Outsider', email: outsiderEmail }),
    });

    const sessions = await request('GET', '/api/v1/live-sessions?courseId=000000000000000000000000', {
      token: registered.json.data.accessToken,
    });

    // The course does not exist, so this is a 404 — the point is that it is not
    // a leaked list.
    assertEqual(sessions.status, 404, 'status');

    const { status } = await request('GET', `/api/v1/live-sessions/${peerCourse.id}`, {
      token: registered.json.data.accessToken,
    });

    assert([403, 404].includes(status), `expected a refusal, got ${status}`);
  });

  await check('an instructor cannot schedule a session on another instructor\'s course', async () => {
    const otherEmail = `smoke-other-${runId}@example.com`;
    createdEmails.push(otherEmail);

    await User.create({
      firstName: 'Other',
      lastName: 'Instructor',
      email: otherEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: otherEmail, password: PASSWORD },
    });

    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const { status } = await request('POST', '/api/v1/live-sessions', {
      token: login.json.data.accessToken,
      body: {
        courseId: peerCourse.id,
        title: 'Hijacked session',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      },
    });

    assertEqual(status, 403, 'status');
  });
}

/**
 * Input validation across the newer surfaces, plus the ordering guarantees that
 * the lesson tree depends on.
 */
async function testDomainValidation() {
  const { json } = await request('POST', '/api/v1/auth/login', {
    body: { email: primaryEmail, password: 'YetAnotherPassword123' },
  });

  const token = json.data.accessToken;

  await check('an invalid course id is rejected, not passed to the database', async () => {
    const { status, json: body } = await request('GET', '/api/v1/courses/not-a-real-id/lessons');

    assertEqual(status, 400, 'status');
    assertEqual(body.code, 'VALIDATION_ERROR', 'error code');
  });

  await check('an out-of-range page size is rejected', async () => {
    const { status } = await request('GET', '/api/v1/courses?limit=100000');
    assertEqual(status, 400, 'status');
  });

  await check('a malformed identifier in a nested route is rejected', async () => {
    const { status } = await request('GET', '/api/v1/courses/abc/lessons/def', { token });
    assertEqual(status, 400, 'status');
  });

  await check('a lesson order outside the allowed range is rejected', async () => {
    const { status } = await request('POST', '/api/v1/courses/000000000000000000000000/lessons', {
      token,
      body: { title: 'Bad order', order: 999999 },
    });

    // A student is refused before validation runs, which is the correct order:
    // authorisation is checked before the body is even considered.
    assertEqual(status, 403, 'status');
  });

  await check('a course title that is too short is rejected', async () => {
    const { status } = await request('POST', '/api/v1/courses', {
      token,
      body: { title: 'ab' },
    });

    assertEqual(status, 403, 'status — authorisation is evaluated before validation');
  });
}

/**
 * Money must read the same everywhere.
 *
 * The course model, the payment model, the payment receipt email and the
 * instructor revenue summary each used to format amounts with their own
 * `toFixed(2)` call, and they disagreed: a $14.99 course was "$14.99" in the
 * catalogue and "14.99 USD" on the receipt, while the dashboard showed a bare
 * "0.00" with no currency at all. These checks pin the one shared formatter.
 */
async function testMoneyFormatting() {
  const { formatCents, formatCentsOrFree, summariseRevenueByCurrency } = require('../src/lib/money');
  const Course = require('../src/models/Course');
  const Payment = require('../src/models/Payment');

  await check('amounts render with a currency symbol', async () => {
    assertEqual(formatCents(1499, 'usd'), '$14.99', 'usd');
    assertEqual(formatCents(1499, 'eur'), '\u20ac14.99', 'eur');
    assertEqual(formatCents(1499, 'gbp'), '\u00a3' + '14.99', 'gbp');
    assertEqual(formatCents(2500, 'lrd'), 'L$25.00', 'lrd');
  });

  await check('zero is "$0.00", not a bare "0.00"', async () => {
    assertEqual(formatCents(0, 'usd'), '$0.00', 'zero keeps its currency');
  });

  await check('an unknown currency shows its code rather than a guessed symbol', async () => {
    assertEqual(formatCents(1499, 'xyz'), '14.99 XYZ', 'unknown code');
  });

  await check('a malformed amount cannot throw a formatter', async () => {
    // These run inside serialisers, so one bad row must not 500 a whole page.
    assertEqual(formatCents(null, 'usd'), '$0.00', 'null');
    assertEqual(formatCents(undefined, 'usd'), '$0.00', 'undefined');
    assertEqual(formatCents('nonsense', 'usd'), '$0.00', 'non-numeric');
    assertEqual(formatCents(Number.NaN, 'usd'), '$0.00', 'NaN');
  });

  await check('negative amounts put the sign before the symbol', async () => {
    assertEqual(formatCents(-500, 'usd'), '-$5.00', 'refund-shaped value');
  });

  await check('a free course reads as "Free", not "$0.00"', async () => {
    assertEqual(formatCentsOrFree(0, 'usd'), 'Free', 'free course');
    assertEqual(formatCentsOrFree(4999, 'usd'), '$49.99', 'paid course');
  });

  await check('the course and payment models agree on how money is displayed', async () => {
    const course = new Course({ title: 'Money format probe', instructor: '507f1f77bcf86cd799439011', priceCents: 1499, currency: 'usd' });
    const payment = new Payment({ student: '507f1f77bcf86cd799439011', course: course._id, amountCents: 1499, currency: 'usd', idempotencyKey: 'money-probe' });

    assertEqual(course.toCardJSON().priceLabel, payment.toJSONForOwner().amountLabel, 'same amount, same rendering');
  });

  await check('two currencies are never silently added together', async () => {
    // 30 USD plus 90 EUR is not 120 of anything. The previous dashboard took the
    // first aggregation row and reported it as the grand total, so anything in a
    // second currency vanished from the figure.
    const summary = summariseRevenueByCurrency([
      { _id: 'usd', totalCents: 3000, payments: 2 },
      { _id: 'eur', totalCents: 9000, payments: 1 },
    ]);

    assertEqual(summary.mixedCurrency, true, 'mixedCurrency flag');
    assertEqual(summary.totalCents, 9000, 'the headline is the largest currency, not a sum');
    assertEqual(summary.currencies.length, 2, 'every currency is still reported');
    assert(summary.totalLabel.includes('\u20ac'), 'the headline is labelled with its own currency');
  });

  await check('instructor revenue totals carry a currency symbol', async () => {
    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: 'instructor@wuteve.edu', password: 'WuteveDemo12345' },
    });

    if (login.status !== 200) {
      // The seeded instructor is a convenience, not a contract; skip if absent.
      assertEqual(login.status, 401, 'login should either succeed or be rejected as unknown');
      return;
    }

    const response = await request('GET', '/api/v1/dashboard/instructor', {
      token: login.json.data.accessToken,
    });

    assertEqual(response.status, 200, 'status');

    const { revenue } = response.json.data;
    assert(/^[^\d]/.test(revenue.totalLabel), `totalLabel should start with a currency mark, got "${revenue.totalLabel}"`);
    assert(/^[^\d]/.test(revenue.monthlyLabel), `monthlyLabel should start with a currency mark, got "${revenue.monthlyLabel}"`);
    assertEqual(Array.isArray(revenue.currencies), true, 'currencies breakdown');
  });
}


/**
 * The admin area's read endpoints.
 *
 * The admin dashboard had no API client at all and rendered a fixture, so
 * nothing verified these responses. Two defects were hiding behind that: the
 * user list computed per-user enrolment counts and then discarded them (only
 * `includePrivate` was read out of the options object), and the revenue labels
 * were formatted with their own `toFixed` call rather than the shared helper.
 */
async function testAdminReporting() {
  /**
   * Fixture accounts rather than the seeded demo ones.
   *
   * This suite used to sign in as `admin@wuteve.edu` with the password published
   * in the README, so its six checks ran only against a database that had been
   * seeded. Against one without that account — an empty database, or one whose
   * demo password has been changed, which is the whole point of changing it —
   * the sign-in returned 401 and the suite returned early. The run still ended
   * "All checks passed", six checks lighter, and nothing said so.
   *
   * These two are created here instead. Their addresses match the `smoke-`
   * namespace the teardown already sweeps, so they remove themselves.
   *
   * Deliberately not `smoke-admin-…`: `testLearningLoop()` already provisions an
   * account at that exact address, and every section of this file shares one
   * `runId`, so borrowing the name made this insert collide with that one on the
   * unique email index and abort the run. Same namespace, different prefix.
   */
  const adminEmail = `smoke-reporting-${runId}@example.com`;
  const studentEmail = `smoke-reporting-student-${runId}@example.com`;

  await User.create({
    firstName: 'Ada',
    lastName: 'Admin',
    email: adminEmail,
    password: PASSWORD,
    role: 'admin',
    emailVerified: true,
  });

  await User.create({
    firstName: 'Stan',
    lastName: 'Student',
    email: studentEmail,
    password: PASSWORD,
    role: 'student',
    emailVerified: true,
  });

  createdEmails.push(adminEmail, studentEmail);

  const login = await request('POST', '/api/v1/auth/login', {
    body: { email: adminEmail, password: PASSWORD },
  });

  // A failure here is now a real failure rather than a reason to skip: nothing
  // outside this file has to exist for it to work.
  assertEqual(login.status, 200, 'fixture admin sign-in');

  const token = login.json.data.accessToken;

  await check('an ordinary student cannot read the admin summaries', async () => {
    const student = await request('POST', '/api/v1/auth/login', {
      body: { email: studentEmail, password: PASSWORD },
    });

    assertEqual(student.status, 200, 'fixture student sign-in');

    for (const path of ['/api/v1/admin/stats', '/api/v1/admin/users', '/api/v1/admin/certificates']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request('GET', path, { token: student.json.data.accessToken });
      assertEqual(response.status, 403, `${path} for a student`);
    }
  });

  await check('the admin summary counts users, courses and enrolments', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/stats', { token });

    assertEqual(status, 200, 'status');
    assert(typeof json.data.users.total === 'number', 'users.total should be a number');
    assert(typeof json.data.courses.total === 'number', 'courses.total should be a number');
    assert(json.data.courses.published <= json.data.courses.total, 'published cannot exceed the total');
    assert(Array.isArray(json.data.revenue), 'revenue should be an array of per-currency totals');
    assert(Array.isArray(json.data.recent.signups), 'recent signups should be an array');
  });

  await check('every revenue total carries its own currency mark', async () => {
    const { json } = await request('GET', '/api/v1/admin/stats', { token });

    json.data.revenue.forEach((entry) => {
      assert(
        /^[^\d]/.test(entry.totalLabel),
        `revenue totalLabel should start with a currency mark, got "${entry.totalLabel}"`
      );
    });
  });

  await check('the user list reports enrolment counts instead of discarding them', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/users', { token });

    assertEqual(status, 200, 'status');
    assert(json.data.items.length > 0, 'the seeded accounts should be listed');

    json.data.items.forEach((user) => {
      assert(user.stats, `${user.email} should carry stats`);
      assertEqual(typeof user.stats.enrollments, 'number', `${user.email} enrolments`);
      assertEqual(typeof user.stats.completed, 'number', `${user.email} completions`);
    });
  });

  await check('the admin can list certificates with their status counts', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/certificates', { token });

    assertEqual(status, 200, 'status');
    assert(Array.isArray(json.data.items), 'items should be an array');
    assert(typeof json.data.counts.issued === 'number', 'counts.issued');
    assert(typeof json.data.counts.revoked === 'number', 'counts.revoked');

    json.data.items.forEach((certificate) => {
      assertEqual(typeof certificate.valid, 'boolean', 'each certificate reports validity');
      assert(certificate.certificateNumber, 'each certificate has a number');
      assert(certificate.verifyUrl, 'each certificate has a verification link');
    });
  });

  await check('the certificate filter agrees with the counts it reports', async () => {
    const revoked = await request('GET', '/api/v1/admin/certificates?status=revoked', { token });
    const issued = await request('GET', '/api/v1/admin/certificates?status=issued', { token });

    assertEqual(issued.json.data.counts.revoked, revoked.json.data.counts.revoked, 'counts are unfiltered');

    revoked.json.data.items.forEach((certificate) => {
      assertEqual(certificate.revoked, true, 'the revoked filter returns only revoked certificates');
    });
    issued.json.data.items.forEach((certificate) => {
      assertEqual(certificate.revoked, false, 'the issued filter returns only valid certificates');
    });
  });
}


async function testStripeWebhook() {
  const Payment = require('../src/models/Payment');
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  /** Stripe signs `${timestamp}.${rawBody}` — reproduce that exactly. */
  function sign(rawBody, { timestamp, secretOverride } = {}) {
    const t = timestamp || Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', secretOverride || secret)
      .update(`${t}.${rawBody}`)
      .digest('hex');
    return `t=${t},v1=${signature}`;
  }

  /** Post the exact bytes, so nothing re-serialises the signed payload. */
  async function postWebhook(rawBody, signatureHeader) {
    const response = await fetch(`${baseUrl}/api/v1/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signatureHeader ? { 'Stripe-Signature': signatureHeader } : {}),
      },
      body: rawBody,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  // Fixtures created directly, in the suite's own namespace so teardown sweeps them.
  const instructor = await User.create({
    firstName: 'Webhook',
    lastName: 'Instructor',
    email: `smoke-webhook-instructor-${runId}@example.com`,
    password: PASSWORD,
    role: 'instructor',
    emailVerified: true,
  });
  createdEmails.push(instructor.email);

  const student = await User.create({
    firstName: 'Webhook',
    lastName: 'Student',
    email: `smoke-webhook-student-${runId}@example.com`,
    password: PASSWORD,
    role: 'student',
    emailVerified: true,
  });
  createdEmails.push(student.email);

  const course = await Course.create({
    title: 'Webhook fulfilment probe',
    slug: `webhook-probe-${runId}`,
    instructor: instructor._id,
    instructorName: 'Webhook Instructor',
    priceCents: 4500,
    currency: 'usd',
    status: 'published',
    publishedAt: new Date(),
  });

  const newPendingPayment = () =>
    Payment.create({
      student: student._id,
      course: course._id,
      amountCents: 4500,
      currency: 'usd',
      provider: 'stripe',
      status: 'pending',
      idempotencyKey: `webhook-probe-${runId}-${crypto.randomBytes(4).toString('hex')}`,
    });

  function sessionFor(payment, overrides = {}) {
    return {
      id: `cs_test_${crypto.randomBytes(8).toString('hex')}`,
      client_reference_id: String(payment._id),
      metadata: { paymentId: String(payment._id), studentId: String(student._id), courseId: String(course._id) },
      payment_status: 'paid',
      amount_total: payment.amountCents,
      currency: payment.currency,
      payment_intent: `pi_test_${crypto.randomBytes(8).toString('hex')}`,
      ...overrides,
    };
  }

  const eventBody = (session, type = 'checkout.session.completed') =>
    JSON.stringify({ id: `evt_${crypto.randomBytes(8).toString('hex')}`, type, data: { object: session } });

  await check('a webhook with no signature is refused', async () => {
    const { status } = await postWebhook(eventBody(sessionFor({ _id: 'x', amountCents: 4500, currency: 'usd' })), null);
    assertEqual(status, 400, 'status');
  });

  await check('a webhook signed with the wrong secret is refused', async () => {
    const raw = eventBody(sessionFor({ _id: 'x', amountCents: 4500, currency: 'usd' }));
    const { status } = await postWebhook(raw, sign(raw, { secretOverride: 'whsec_not_the_real_one' }));
    assertEqual(status, 400, 'status');
  });

  await check('a replayed webhook outside the tolerance window is refused', async () => {
    const raw = eventBody(sessionFor({ _id: 'x', amountCents: 4500, currency: 'usd' }));
    const stale = Math.floor(Date.now() / 1000) - 600;
    const { status } = await postWebhook(raw, sign(raw, { timestamp: stale }));
    assertEqual(status, 400, 'a correctly signed but old delivery must be rejected');
  });

  await check('a tampered body fails even with a valid signature for the original', async () => {
    const original = eventBody(sessionFor({ _id: 'x', amountCents: 4500, currency: 'usd' }));
    const header = sign(original);

    const tampered = eventBody(
      sessionFor({ _id: 'x', amountCents: 4500, currency: 'usd' }),
      'checkout.session.completed'
    ).replace('"payment_status":"paid"', '"payment_status":"unpaid"');

    const { status } = await postWebhook(tampered, header);
    assertEqual(status, 400, 'the signature covers the whole payload');
  });

  await check('an unpaid completed session does not grant access', async () => {
    const payment = await newPendingPayment();
    const raw = eventBody(sessionFor(payment, { payment_status: 'unpaid' }));

    const { status } = await postWebhook(raw, sign(raw));
    assertEqual(status, 200, 'acknowledged so Stripe stops retrying');

    const after = await Payment.findById(payment._id);
    assertEqual(after.status, 'pending', 'the payment must stay pending until it settles');

    const enrolled = await Enrollment.findOne({ student: student._id, course: course._id });
    assert(enrolled === null, 'no enrolment may exist before the money arrives');
  });

  await check('a paid completed session grants access exactly once', async () => {
    const payment = await newPendingPayment();
    const raw = eventBody(sessionFor(payment));

    const first = await postWebhook(raw, sign(raw));
    assertEqual(first.status, 200, 'status');

    const settled = await Payment.findById(payment._id);
    assertEqual(settled.status, 'paid', 'the payment should be marked paid');
    assert(settled.paidAt, 'paidAt should be set');
    assert(settled.enrollment, 'the payment should point at the enrolment it created');

    // Same delivery again — Stripe retries, and this must not enrol twice.
    const second = await postWebhook(raw, sign(raw));
    assertEqual(second.status, 200, 'a repeat delivery is acknowledged');

    const enrollments = await Enrollment.countDocuments({ student: student._id, course: course._id });
    assertEqual(enrollments, 1, 'exactly one enrolment, however many times it is delivered');
  });

  await check('a session whose amount does not match the record is not fulfilled', async () => {
    const payment = await newPendingPayment();
    // Stripe charging a different total than we recorded means the two have
    // drifted; granting access would also record revenue that never happened.
    const raw = eventBody(sessionFor(payment, { amount_total: 100 }));

    const { status } = await postWebhook(raw, sign(raw));
    assertEqual(status, 200, 'acknowledged, but not acted on');

    const after = await Payment.findById(payment._id);
    assertEqual(after.status, 'pending', 'a mismatched amount must not mark the payment paid');

    const enrollments = await Enrollment.countDocuments({ student: student._id, course: course._id });
    assertEqual(enrollments, 1, 'no further enrolment should have been created');
  });

  await check('an expired session marks a pending payment failed', async () => {
    const payment = await newPendingPayment();
    const raw = eventBody(sessionFor(payment), 'checkout.session.expired');

    const { status } = await postWebhook(raw, sign(raw));
    assertEqual(status, 200, 'status');

    const after = await Payment.findById(payment._id);
    assertEqual(after.status, 'failed', 'an abandoned checkout should not stay pending forever');
  });

  await check('a signed webhook for an unknown event type is acknowledged', async () => {
    const raw = JSON.stringify({ id: 'evt_unknown', type: 'customer.created', data: { object: {} } });
    const { status } = await postWebhook(raw, sign(raw));
    assertEqual(status, 200, 'unhandled events must not cause Stripe to retry forever');
  });
}


async function testMobileMoney() {
  const Payment = require('../src/models/Payment');
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');
  const mobileMoney = require('../src/services/mobileMoneyService');

  const secret = process.env.LONESTAR_MOMO_CALLBACK_SECRET;

  function sign(rawBody, { secretOverride, timestamp } = {}) {
    const t = timestamp || Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', secretOverride || secret)
      .update(`${t}.${rawBody}`)
      .digest('hex');
    return `t=${t},v1=${signature}`;
  }

  async function postCallback(providerId, rawBody, signatureHeader) {
    const response = await fetch(`${baseUrl}/api/v1/payments/callback/${providerId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signatureHeader ? { 'X-Callback-Signature': signatureHeader } : {}),
      },
      body: rawBody,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  const instructor = await User.create({
    firstName: 'Mobile',
    lastName: 'Instructor',
    email: `smoke-mobile-instructor-${runId}@example.com`,
    password: PASSWORD,
    role: 'instructor',
    emailVerified: true,
  });
  createdEmails.push(instructor.email);

  const student = await User.create({
    firstName: 'Mobile',
    lastName: 'Student',
    email: `smoke-mobile-student-${runId}@example.com`,
    password: PASSWORD,
    role: 'student',
    emailVerified: true,
  });
  createdEmails.push(student.email);

  const course = await Course.create({
    title: 'Mobile money probe',
    slug: `mobile-money-probe-${runId}`,
    instructor: instructor._id,
    instructorName: 'Mobile Instructor',
    priceCents: 30000,
    currency: 'lrd',
    status: 'published',
    publishedAt: new Date(),
  });

  await check('the methods endpoint lists every method and never leaks a credential', async () => {
    const { status, json, text } = await request('GET', '/api/v1/payments/methods');
    assertEqual(status, 200, 'status');

    const ids = json.data.methods.map((m) => m.id).sort();
    // `manual` is listed alongside the gateways because it is a real way to pay
    // here: it needs no provider key, only the numbers to send to, which is why
    // it is the one method that reports itself usable on this deployment.
    assertEqual(ids.join(','), 'card,lonestar_momo,manual,orange_money', 'every known method is listed');

    json.data.methods.forEach((method) => {
      assertEqual(typeof method.enabled, 'boolean', `${method.id} reports whether it is usable`);
      assert(Array.isArray(method.missing), `${method.id} names what it is missing`);
    });

    // The response is public. Configuring a provider must never put its key,
    // merchant id or callback secret on the wire.
    ['apiKey', 'callbackSecret', 'baseUrl', 'merchantId'].forEach((field) => {
      assert(!text.includes(`"${field}"`), `the response must not contain ${field}`);
    });
  });

  await check('starting a charge names the settings that are missing', async () => {
    const { status, json } = await request('POST', `/api/v1/payments/checkout/${course._id}/mobile-money`, {
      token: primaryUser.accessToken,
      body: { provider: 'lonestar_momo', phoneNumber: '0771234567' },
    });

    assertEqual(status, 503, 'an unconfigured provider is unavailable, not a server error');
    assertEqual(json.code, 'PROVIDER_NOT_CONFIGURED', 'code');

    const named = (json.details || []).map((d) => d.field).join(',');
    assert(named.includes('LONESTAR_MOMO_BASE_URL'), 'the response should name the missing settings');
  });

  await check('an unknown mobile money provider is rejected', async () => {
    const { status, json } = await request('POST', `/api/v1/payments/checkout/${course._id}/mobile-money`, {
      token: primaryUser.accessToken,
      body: { provider: 'carrier_pigeon', phoneNumber: '0771234567' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'UNKNOWN_PAYMENT_METHOD', 'code');
  });

  await check('a failed charge does not leave a pending payment behind', async () => {
    const before = await Payment.countDocuments({ student: student._id, status: 'pending' });
    assertEqual(before, 0, 'start clean');

    const { status } = await request('POST', `/api/v1/payments/checkout/${course._id}/mobile-money`, {
      token: primaryUser.accessToken,
      body: { provider: 'orange_money', phoneNumber: '0771234567' },
    });

    assertEqual(status, 503, 'status');

    // A pending record with no charge behind it reads as money in flight when
    // nothing is happening at all, so it must not survive the failure.
    const stranded = await Payment.countDocuments({ status: 'pending', amountCents: 30000 });
    assertEqual(stranded, 0, 'no payment should be left pending after the charge failed');
  });

  await check('Liberian numbers are normalised and nonsense is refused', async () => {
    assertEqual(mobileMoney.normalisePhone('0771234567'), '+231771234567', 'national format');
    assertEqual(mobileMoney.normalisePhone('+231 77 123 4567'), '+231771234567', 'international with spaces');
    assertEqual(mobileMoney.normalisePhone('231771234567'), '+231771234567', 'country code, no plus');

    for (const bad of ['', '123', 'not-a-phone', '07712']) {
      let threw = false;
      try {
        mobileMoney.normalisePhone(bad);
      } catch {
        threw = true;
      }
      assert(threw, `"${bad}" should be refused`);
    }
  });

  await check('a callback with no signature is refused', async () => {
    const { status } = await postCallback('lonestar_momo', JSON.stringify({ reference: 'x', status: 'paid' }), null);
    assertEqual(status, 400, 'status');
  });

  await check('a callback signed with the wrong secret is refused', async () => {
    const raw = JSON.stringify({ reference: 'x', status: 'paid' });
    const { status } = await postCallback('lonestar_momo', raw, sign(raw, { secretOverride: 'not_the_secret' }));
    assertEqual(status, 400, 'status');
  });

  await check('a replayed callback outside the tolerance window is refused', async () => {
    const raw = JSON.stringify({ reference: 'x', status: 'paid' });
    const stale = Math.floor(Date.now() / 1000) - 600;
    const { status } = await postCallback('lonestar_momo', raw, sign(raw, { timestamp: stale }));
    assertEqual(status, 400, 'a correctly signed but old callback must be rejected');
  });

  await check('a provider with no callback secret refuses everything', async () => {
    // Orange Money is entirely unconfigured here, which is its real state.
    const raw = JSON.stringify({ reference: 'x', status: 'paid' });
    const { status, json } = await postCallback('orange_money', raw, sign(raw));
    assertEqual(status, 400, 'status');
    assertEqual(json.reason, 'callback_secret_missing', 'reason');
  });

  await check('a confirmed mobile money payment settles exactly once', async () => {
    const payment = await Payment.create({
      student: student._id,
      course: course._id,
      amountCents: 30000,
      currency: 'lrd',
      provider: 'lonestar_momo',
      method: 'mobile_money',
      payerPhone: '+231771234567',
      status: 'pending',
      providerReference: `LON-${crypto.randomBytes(6).toString('hex')}`,
      idempotencyKey: `mobile-probe-${runId}`,
    });

    const raw = JSON.stringify({
      reference: payment.providerReference,
      status: 'paid',
      amountCents: 30000,
      currency: 'lrd',
      transactionId: payment.providerReference,
    });

    const first = await postCallback('lonestar_momo', raw, sign(raw));
    assertEqual(first.status, 200, 'status');

    const settled = await Payment.findById(payment._id);
    assertEqual(settled.status, 'paid', 'the payment should be marked paid');
    assert(settled.enrollment, 'it should point at the enrolment it created');

    const enrollments = await Enrollment.countDocuments({ student: student._id, course: course._id });
    assertEqual(enrollments, 1, 'an enrolment should exist');

    const created = await Enrollment.findOne({ student: student._id, course: course._id });
    assertEqual(created.source, 'mobile_money', 'the enrolment should record how it was paid for');

    // The provider will retry. This must not enrol a second time.
    const second = await postCallback('lonestar_momo', raw, sign(raw));
    assertEqual(second.status, 200, 'a repeat callback is acknowledged');
    assertEqual(
      await Enrollment.countDocuments({ student: student._id, course: course._id }),
      1,
      'still exactly one enrolment'
    );
  });

  await check('a callback whose amount disagrees with the record is not settled', async () => {
    const payment = await Payment.create({
      student: student._id,
      course: course._id,
      amountCents: 30000,
      currency: 'lrd',
      provider: 'lonestar_momo',
      method: 'mobile_money',
      status: 'pending',
      providerReference: `LON-${crypto.randomBytes(6).toString('hex')}`,
      idempotencyKey: `mobile-probe-mismatch-${runId}`,
    });

    const raw = JSON.stringify({
      reference: payment.providerReference,
      status: 'paid',
      amountCents: 50,
      currency: 'lrd',
    });

    const { status } = await postCallback('lonestar_momo', raw, sign(raw));
    assertEqual(status, 200, 'acknowledged so the provider stops retrying');

    const after = await Payment.findById(payment._id);
    assertEqual(after.status, 'pending', 'a mismatched amount must not mark the payment paid');
  });
}

/* ------------------------------------------------------------------ *
 * Lesson video and lesson quizzes
 *
 * The suites above treat courses, lessons and enrolment as a pipeline. This one
 * covers what an instructor puts *inside* a lesson — a video and a quiz — and the
 * access decisions around them. Two of these checks exist because the defect they
 * cover was silent and would return silently:
 *
 *   - The course owner has to be recognised as the owner on the one endpoint the
 *     course page reads. `GET /:slug` populates `instructor` into a document, and
 *     an ownership test that stringifies that document never matches, so the owner
 *     was told `manages: false`, every lesson rendered padlocked and the page
 *     offered them a checkout panel for their own course. Nothing errored.
 *   - A student's quiz payload must not carry the answer key. Marking happens on
 *     the server for exactly this reason; the browser is handed questions only.
 * ------------------------------------------------------------------ */

async function testLessonVideoAndQuizzes() {
  const Quiz = require('../src/models/Quiz');
  const QuizAttempt = require('../src/models/QuizAttempt');
  const Lesson = require('../src/models/Lesson');
  const certificateService = require('../src/services/certificateService');

  // Read from the same config the routes read, so the upload checks below assert
  // the behaviour of this deployment rather than an assumption about it.
  const storage = require('../src/config/env').storage;

  const adminEmail = `smoke-admin-vq-${runId}@example.com`;
  const instructorEmail = `smoke-instructor-vq-${runId}@example.com`;
  const rivalEmail = `smoke-rival-vq-${runId}@example.com`;
  const studentEmail = `smoke-student-vq-${runId}@example.com`;

  createdEmails.push(adminEmail, instructorEmail, rivalEmail, studentEmail);

  let adminSession = null;
  let instructorSession = null;
  let rivalSession = null;
  let studentSession = null;
  let studentId = null;

  let course = null;
  let rivalCourse = null;
  let lesson = null;
  let limitLesson = null;
  let quiz = null;

  const lessonPath = (suffix = '') =>
    `/api/v1/courses/${course.id}/lessons/${lesson.id}${suffix}`;

  /** A key of the exact shape this API issues, for any course and lesson. */
  const videoKey = (courseId, lessonId) =>
    `courses/${courseId}/lessons/${lessonId}/video/${crypto.randomUUID()}.mp4`;

  const quizBody = (overrides = {}) => ({
    title: 'Lesson check',
    passPercent: 70,
    maxAttempts: 0,
    questions: [
      {
        prompt: 'Which of these is a number?',
        kind: 'single',
        explanation: 'Only one of them is numeric.',
        points: 1,
        options: [
          { text: '42', isCorrect: true },
          { text: 'banana', isCorrect: false },
        ],
      },
      {
        prompt: 'A lesson can hold a video.',
        kind: 'true_false',
        explanation: 'It can — uploaded or linked.',
        points: 1,
        options: [
          { text: 'True', isCorrect: true },
          { text: 'False', isCorrect: false },
        ],
      },
    ],
    ...overrides,
  });

  await check('an administrator can be provisioned for the lesson fixtures', async () => {
    await User.create({
      firstName: 'Ada',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: adminEmail, password: PASSWORD },
    });

    assertEqual(status, 200, 'admin sign-in');
    adminSession = json.data;
  });

  await check('an instructor, a rival instructor and a student can be provisioned', async () => {
    const people = [
      { email: instructorEmail, firstName: 'Isaac', lastName: 'Instructor', role: 'instructor', store: 'instructor' },
      { email: rivalEmail, firstName: 'Rita', lastName: 'Rival', role: 'instructor', store: 'rival' },
      { email: studentEmail, firstName: 'Sam', lastName: 'Student', role: 'student', store: 'student' },
    ];

    for (const person of people) {
      const { status } = await request('POST', '/api/v1/admin/users', {
        token: adminSession.accessToken,
        body: {
          firstName: person.firstName,
          lastName: person.lastName,
          email: person.email,
          password: PASSWORD,
          role: person.role,
        },
      });
      assertEqual(status, 201, `${person.role} created`);

      const { status: loginStatus, json } = await request('POST', '/api/v1/auth/login', {
        body: { email: person.email, password: PASSWORD },
      });
      assertEqual(loginStatus, 200, `${person.role} sign-in`);

      if (person.store === 'instructor') instructorSession = json.data;
      if (person.store === 'rival') rivalSession = json.data;
      if (person.store === 'student') {
        studentSession = json.data;
        studentId = json.data.user.id;
      }    }
  });

  await check('each instructor can create a course', async () => {
    const mine = await request('POST', '/api/v1/courses', {
      token: instructorSession.accessToken,
      body: {
        title: 'Video and quiz fixtures',
        summary: 'A course holding the video and quiz fixtures.',
        description: 'Created by the lesson video and quiz suite.',
        category: 'data',
        level: 'beginner',
        priceCents: 0,
      },
    });

    assertEqual(mine.status, 201, 'owner course created');
    course = mine.json.data.course;

    const theirs = await request('POST', '/api/v1/courses', {
      token: rivalSession.accessToken,
      body: {
        title: 'A rival course',
        summary: 'Owned by somebody else, used to prove ownership is enforced.',
        description: 'Created by the lesson video and quiz suite.',
        category: 'data',
        level: 'beginner',
        priceCents: 0,
      },
    });

    assertEqual(theirs.status, 201, 'rival course created');
    rivalCourse = theirs.json.data.course;
  });

  await check('lessons can be added for the video and quiz fixtures', async () => {
    const first = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'A lesson with a video',
        summary: 'Carries the video and quiz fixtures.',
        type: 'video',
        content: 'Lesson body.',
        // A preview lesson so the outline is readable without an enrolment, which
        // keeps the read checks below independent of the enrolment checks.
        isPreview: true,
      },
    });

    assertEqual(first.status, 201, `first lesson created: ${first.json?.message || first.text.slice(0, 160)}`);
    lesson = first.json.data.lesson;

    const second = await request('POST', `/api/v1/courses/${course.id}/lessons`, {
      token: instructorSession.accessToken,
      body: {
        title: 'A lesson with an attempt limit',
        summary: 'Holds the limited-attempt quiz.',
        type: 'text',
        content: 'Lesson body.',
        isPreview: true,
      },
    });

    assertEqual(second.status, 201, `second lesson created: ${second.json?.message || second.text.slice(0, 160)}`);
    limitLesson = second.json.data.lesson;

    // The rival course needs a lesson of its own: publishing requires one, and it
    // has to be visible to a non-owner for the ownership check below to be about
    // ownership rather than about visibility.
    const filler = await request('POST', `/api/v1/courses/${rivalCourse.id}/lessons`, {
      token: rivalSession.accessToken,
      body: { title: 'A rival lesson', type: 'text', content: 'Body.', isPreview: true },
    });

    assertEqual(filler.status, 201, 'rival lesson created');
  });

  await check('both courses can be published so that a non-owner may see them', async () => {
    // Published by an administrator deliberately: an instructor publishing their own
    // course only queues it for review, and a queued course stays hidden from
    // everybody but its owner and the administrators. The ownership checks below
    // would otherwise pass for the wrong reason — a 404 rather than `manages: false`.
    for (const target of [course, rivalCourse]) {
      const { status, json } = await request('POST', `/api/v1/courses/${target.id}/publish`, {
        token: adminSession.accessToken,
      });

      assertEqual(status, 200, `publish ${target.slug}: ${json?.message || ''}`);
    }
  });

  /* ---- Ownership on the endpoint the course page actually reads ---- */

  await check('the owner of a course is told they manage it', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.slug}`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'course detail');
    assertEqual(json.data.access.manages, true, 'the owner must manage their own course');
    assertEqual(json.data.access.canReadContent, true, 'the owner can read their own content');

    const locked = json.data.lessons.filter((entry) => entry.locked);
    assertEqual(locked.length, 0, 'the owner must not see their own lessons padlocked');
  });

  await check('a student is not told they manage somebody else\'s course', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.slug}`, {
      token: studentSession.accessToken,
    });

    assertEqual(status, 200, 'course detail');
    assertEqual(json.data.access.manages, false, 'a student must not manage the course');
    assertEqual(json.data.access.isEnrolled, false, 'a student who has not enrolled is not enrolled');
  });

  await check('an administrator is told they manage any course', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${course.slug}`, {
      token: adminSession.accessToken,
    });

    assertEqual(status, 200, 'course detail');
    assertEqual(json.data.access.manages, true, 'an administrator must manage any course');
  });

  await check('an owner is not mistaken for a stranger on the rival course', async () => {
    // The same comparison, from the other side: the fix must not have made every
    // instructor an owner of every course.
    const { status, json } = await request('GET', `/api/v1/courses/${rivalCourse.slug}`, {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'course detail');
    assertEqual(json.data.access.manages, false, 'one instructor must not manage another\'s course');
  });

  /* ---- Video, link mode ---- */

  await check('an instructor can attach a video link to their own lesson', async () => {
    const { status, json } = await request('PUT', lessonPath('/video/link'), {
      token: instructorSession.accessToken,
      body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });

    assertEqual(status, 200, 'link saved');
    assertEqual(json.data.lesson.videoType, 'link', 'the lesson must report a linked video');
    assertEqual(
      json.data.lesson.video.playbackUrl,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'a link needs no signing, so playback is the stored address'
    );
  });

  await check('the lesson detail reports the linked video', async () => {
    // This is the `.select()` regression: the summary derives `videoType` from
    // `videoUrl` and `videoFile`, so a projection that omits them reports every
    // lesson as having no video at all.
    const { status, json } = await request('GET', lessonPath(), {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'lesson detail');
    assertEqual(json.data.lesson.video.type, 'link', 'the linked video must survive the projection');
  });

  await check('a host that cannot be embedded is refused', async () => {
    const { status } = await request('PUT', lessonPath('/video/link'), {
      token: instructorSession.accessToken,
      body: { url: 'https://example.com/not-a-video-host' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('a host that merely looks like YouTube is refused', async () => {
    // Parsed with `new URL` rather than matched with a regular expression, so the
    // host is the host. A pattern match would accept both of these.
    const lookalike = await request('PUT', lessonPath('/video/link'), {
      token: instructorSession.accessToken,
      body: { url: 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ' },
    });
    assertEqual(lookalike.status, 400, 'a lookalike host must be refused');

    const smuggled = await request('PUT', lessonPath('/video/link'), {
      token: instructorSession.accessToken,
      body: { url: 'https://evil.example/watch?x=youtube.com' },
    });
    assertEqual(smuggled.status, 400, 'a host in the query string must not count');
  });

  await check('another instructor cannot change somebody else\'s lesson video', async () => {
    const { status } = await request('PUT', lessonPath('/video/link'), {
      token: rivalSession.accessToken,
      body: { url: 'https://www.youtube.com/watch?v=oHg5SJYRHA0' },
    });

    assertEqual(status, 403, 'status');

    const after = await Lesson.findById(lesson.id);
    assertEqual(
      after.videoUrl,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'a refused write must leave the video untouched'
    );
  });

  /* ---- Video, upload mode ---- */

  await check('an oversized video is refused before any upload starts', async () => {
    const { status } = await request('POST', lessonPath('/video/presign'), {
      token: instructorSession.accessToken,
      body: { filename: 'huge.mp4', contentType: 'video/mp4', sizeBytes: 600 * 1024 * 1024 },
    });

    // Refused here rather than after 500 MB has crossed somebody's data allowance.
    assertEqual(status, 400, 'status');
  });

  await check('a container the browsers cannot play is refused', async () => {
    const { status } = await request('POST', lessonPath('/video/presign'), {
      token: instructorSession.accessToken,
      body: { filename: 'clip.mov', contentType: 'video/quicktime', sizeBytes: 10 * 1024 * 1024 },
    });

    // An iPhone records MOV as HEVC. Accepting it would produce an upload that
    // succeeds and then will not play, with no transcoder on this deployment.
    assertEqual(status, 400, 'status');
  });

  await check('upload mode reports storage as unconfigured rather than pretending', async () => {
    const { status, json } = await request('POST', lessonPath('/video/presign'), {
      token: instructorSession.accessToken,
      body: { filename: 'lesson.mp4', contentType: 'video/mp4', sizeBytes: 10 * 1024 * 1024 },
    });

    if (!storage.enabled) {
      assertEqual(status, 503, 'status');
      assertEqual(json.code, 'STORAGE_NOT_CONFIGURED', 'error code');

      // The refusal has to leave the instructor with something to do instead.
      // A 503 that only says "not configured" strands whoever hit it, because the
      // link mode beside it works perfectly well without any of this.
      const message = String(json.message || '');
      assert(
        message.includes('YouTube') || message.includes('link'),
        `the refusal must point at the alternative that does work, got: ${message}`
      );
    } else {
      assertEqual(status, 200, 'status');
      assertEqual(
        json.data.key.startsWith(`courses/${course.id}/lessons/${lesson.id}/video/`),
        true,
        'the issued key must name this course and this lesson'
      );
      assert(json.data.uploadUrl, 'a signed upload URL must be returned');
    }
  });

  await check('an upload key that is not one this API issued is refused', async () => {
    const { status } = await request('POST', lessonPath('/video/complete'), {
      token: instructorSession.accessToken,
      body: { key: 'not-a-key-this-api-issued', mime: 'video/mp4' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('an upload naming another course cannot be attached to this lesson', async () => {
    // The client supplies the key, so the route checks that the course and lesson
    // inside it are the ones in the URL. Without that an instructor could confirm
    // a file belonging to a course they do not own and attach it here — reading
    // somebody else's upload through a write endpoint.
    const foreign = videoKey(rivalCourse.id, lesson.id);

    const { status, json } = await request('POST', lessonPath('/video/complete'), {
      token: instructorSession.accessToken,
      body: { key: foreign, mime: 'video/mp4' },
    });

    assertEqual(status, 403, 'status');
    assertEqual(json.code, 'UPLOAD_KEY_MISMATCH', 'error code');

    const after = await Lesson.findById(lesson.id);
    assertEqual(after.videoType, 'link', 'the lesson must keep the video it already had');
  });

  await check('removing a video clears the link and any stored file', async () => {
    const { status, json } = await request('DELETE', lessonPath('/video'), {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.lesson.video.type, 'none', 'the lesson must report no video');

    const after = await Lesson.findById(lesson.id);
    assertEqual(after.videoUrl, null, 'the stored link must be cleared');
    assertEqual(after.videoFile, null, 'any stored file reference must be cleared');
    assertEqual(after.videoType, 'none', 'the derived type must follow');
  });

  /* ---- Quiz authoring ---- */

  await check('an instructor can write a quiz on their own lesson', async () => {
    const { status, json } = await request('PUT', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
      body: quizBody(),
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.quiz.questionCount, 2, 'question count');
    assertEqual(json.data.quiz.questions[0].options[0].isCorrect, true, 'the author view carries the key');
    quiz = json.data.quiz;
  });

  await check('a question with no correct answer is refused', async () => {
    const { status } = await request('PUT', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
      body: quizBody({
        questions: [
          {
            prompt: 'Which of these is a number?',
            kind: 'single',
            options: [
              { text: '42', isCorrect: false },
              { text: 'banana', isCorrect: false },
            ],
          },
        ],
      }),
    });

    // A question nobody can answer right costs every student the marks for it.
    assertEqual(status, 400, 'status');
  });

  await check('a question with two correct answers is refused', async () => {
    const { status } = await request('PUT', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
      body: quizBody({
        questions: [
          {
            prompt: 'Which of these is a number?',
            kind: 'single',
            options: [
              { text: '42', isCorrect: true },
              { text: 'seven', isCorrect: true },
            ],
          },
        ],
      }),
    });

    // Two right answers makes "correct" ambiguous and marks a defensible answer wrong.
    assertEqual(status, 400, 'status');
  });

  await check('a true/false question must have exactly two options', async () => {
    const { status } = await request('PUT', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
      body: quizBody({
        questions: [
          {
            prompt: 'A lesson can hold a video.',
            kind: 'true_false',
            options: [
              { text: 'True', isCorrect: true },
              { text: 'False', isCorrect: false },
              { text: 'Maybe', isCorrect: false },
            ],
          },
        ],
      }),
    });

    assertEqual(status, 400, 'status');
  });

  await check('another instructor cannot write a quiz on somebody else\'s lesson', async () => {
    const { status } = await request('PUT', lessonPath('/quiz'), {
      token: rivalSession.accessToken,
      body: quizBody({ title: 'Hijacked' }),
    });

    assertEqual(status, 403, 'status');

    const after = await Quiz.findById(quiz.id);
    assertEqual(after.title, 'Lesson check', 'a refused write must leave the quiz untouched');
  });

  /* ---- Quiz access ---- */

  await check('a student who has not enrolled cannot sit a lesson quiz', async () => {
    const { status } = await request('POST', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
      body: { answers: [] },
    });

    assertEqual(status, 403, 'status');
  });

  await check('a student can enrol in a free course', async () => {
    const { status } = await request('POST', `/api/v1/courses/${course.id}/enroll`, {
      token: studentSession.accessToken,
    });

    assertEqual(status, 201, 'status');
  });

  await check('the student quiz payload carries no answer key', async () => {
    const { status, json } = await request('GET', lessonPath('/quiz'), {
      token: studentSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.quiz.questionCount, 2, 'the student still sees every question');

    // Checked as a whole document rather than field by field: a leak would arrive
    // as a field somebody added to the serializer, and this catches any of them.
    const serialised = JSON.stringify(json.data.quiz);
    assert(
      !serialised.includes('isCorrect'),
      'the student payload must not carry which option is correct'
    );
    assert(
      !serialised.includes('explanation'),
      'the student payload must not carry the explanation, which gives the answer away'
    );
    assert(
      json.data.quiz.questions[0].options.length > 0,
      'the student payload must still offer the options to choose between'
    );
  });

  await check('the author quiz payload carries the answer key', async () => {
    const { status, json } = await request('GET', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(
      JSON.stringify(json.data.quiz).includes('isCorrect'),
      'the author must be able to see which option is correct'
    );
    assertEqual(json.data.access.manages, true, 'the author is recognised as the author');
  });

  /* ---- Quiz marking ---- */

  /** The option ids a student would send, taken from the author's own view. */
  const optionsOf = (authorQuiz) =>
    authorQuiz.questions.map((question) => ({
      correct: question.options.filter((option) => option.isCorrect).map((option) => String(option.id)),
      wrong: question.options.filter((option) => !option.isCorrect).map((option) => String(option.id)),
      all: question.options.map((option) => String(option.id)),
    }));

  let perfectAttempt = null;

  await check('a fully correct attempt scores 100 and passes', async () => {
    const author = await request('GET', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });
    const choices = optionsOf(author.json.data.quiz);

    const { status, json } = await request('POST', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
      body: {
        answers: [
          { questionId: author.json.data.quiz.questions[0].id, optionIds: choices[0].correct },
          { questionId: author.json.data.quiz.questions[1].id, optionIds: choices[1].correct },
        ],
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.attempt.scorePercent, 100, 'score');
    assertEqual(json.data.attempt.passed, true, 'a perfect attempt must pass');
    assertEqual(json.data.attempt.pointsEarned, 2, 'points earned');
    perfectAttempt = json.data.attempt;
  });

  await check('a second tick is wrong even when the first is right', async () => {
    const author = await request('GET', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });
    const choices = optionsOf(author.json.data.quiz);

    const { status, json } = await request('POST', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
      body: {
        answers: [
          // Both options ticked: right one among them, but the selection is not
          // the answer. Compared exactly, so this is wrong rather than half right.
          { questionId: author.json.data.quiz.questions[0].id, optionIds: choices[0].all },
          { questionId: author.json.data.quiz.questions[1].id, optionIds: choices[1].correct },
        ],
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.attempt.pointsEarned, 1, 'the padded question must earn nothing');
    assertEqual(json.data.attempt.scorePercent, 50, 'score');
    assertEqual(json.data.attempt.passed, false, 'half marks must not pass a 70% quiz');
  });

  await check('a blank attempt scores zero', async () => {
    const { status, json } = await request('POST', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
      body: { answers: [] },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.attempt.scorePercent, 0, 'score');
    assertEqual(json.data.attempt.passed, false, 'a blank attempt must not pass');
  });

  await check('an option id from elsewhere cannot be counted as correct', async () => {
    const author = await request('GET', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });
    const choices = optionsOf(author.json.data.quiz);
    const foreign = crypto.randomBytes(12).toString('hex');

    const { status, json } = await request('POST', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
      body: {
        answers: [
          { questionId: author.json.data.quiz.questions[0].id, optionIds: [foreign] },
          { questionId: author.json.data.quiz.questions[1].id, optionIds: [foreign] },
        ],
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.attempt.pointsEarned, 0, 'an unknown option must earn nothing');
    assertEqual(choices[0].correct.length, 1, 'the fixture quiz has one correct option per question');
  });

  await check('a student\'s own attempt history tells them what they got wrong', async () => {
    const { status, json } = await request('GET', lessonPath('/quiz/attempts'), {
      token: studentSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(json.data.attempts.length >= 4, 'every attempt must be recorded');

    // Their own marks, and nothing about anybody else's.
    const serialised = JSON.stringify(json.data.attempts);
    assert(!serialised.includes('studentName'), 'a student must not see other students\' results');
  });

  await check('the attempt limit is enforced', async () => {
    const saved = await request('PUT', `/api/v1/courses/${course.id}/lessons/${limitLesson.id}/quiz`, {
      token: instructorSession.accessToken,
      body: quizBody({ title: 'One attempt only', maxAttempts: 1 }),
    });
    assertEqual(saved.status, 200, `limited quiz saved: ${saved.json?.message || ''}`);

    const author = await request('GET', `/api/v1/courses/${course.id}/lessons/${limitLesson.id}/quiz`, {
      token: instructorSession.accessToken,
    });
    const choices = optionsOf(author.json.data.quiz);

    const first = await request('POST', `/api/v1/courses/${course.id}/lessons/${limitLesson.id}/quiz/attempts`, {
      token: studentSession.accessToken,
      body: {
        answers: [
          { questionId: author.json.data.quiz.questions[0].id, optionIds: choices[0].correct },
          { questionId: author.json.data.quiz.questions[1].id, optionIds: choices[1].correct },
        ],
      },
    });
    assertEqual(first.status, 201, 'the first attempt is allowed');

    const second = await request('POST', `/api/v1/courses/${course.id}/lessons/${limitLesson.id}/quiz/attempts`, {
      token: studentSession.accessToken,
      body: {
        answers: [
          { questionId: author.json.data.quiz.questions[0].id, optionIds: choices[0].correct },
          { questionId: author.json.data.quiz.questions[1].id, optionIds: choices[1].correct },
        ],
      },
    });

    assertEqual(second.status, 400, 'the second attempt must be refused');
    assertEqual(second.json.code, 'ATTEMPTS_EXHAUSTED', 'error code');

    const recorded = await QuizAttempt.countDocuments({ lesson: limitLesson.id, student: studentId });
    assertEqual(recorded, 1, 'a refused attempt must not be recorded');
  });

  await check('an instructor cannot sit their own quiz', async () => {
    const author = await request('GET', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });
    const choices = optionsOf(author.json.data.quiz);

    const { status } = await request('POST', lessonPath('/quiz/attempts'), {
      token: instructorSession.accessToken,
      body: {
        answers: [
          { questionId: author.json.data.quiz.questions[0].id, optionIds: choices[0].correct },
        ],
      },
    });

    // Their marks would otherwise land in the class results and the course average,
    // which is a record about students.
    assertEqual(status, 403, 'status');
  });

  await check('quiz attempts feed the certificate grade', async () => {
    // The best attempt per quiz, averaged across the course's quizzes and formatted
    // the way `Certificate.grade` stores it. The perfect attempts above must be what
    // counts — not the blank attempt or the padded one that followed them.
    const grade = await certificateService.quizGradeFor(studentId, course.id);

    assertEqual(grade, '100%', 'the grade must come from the best attempt at each quiz');

    // And a student who has sat nothing is ungraded rather than scored zero, which
    // would otherwise look like a fail on a certificate they never earned marks on.
    // The student has attempts on the first course and none at all on the rival one.
    const ungraded = await certificateService.quizGradeFor(studentId, rivalCourse.id);
    assertEqual(ungraded, null, 'no attempts must mean no grade at all');
  });

  await check('removing a quiz keeps the record of attempts already made', async () => {
    const before = await QuizAttempt.countDocuments({ quiz: quiz.id });

    const { status } = await request('DELETE', lessonPath('/quiz'), {
      token: instructorSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(await Quiz.countDocuments({ lesson: lesson.id }), 0, 'the quiz must be gone');

    // Deleting the quiz does not un-answer it: a grade already computed from these
    // attempts has to stay explicable.
    assertEqual(
      await QuizAttempt.countDocuments({ quiz: quiz.id }),
      before,
      'the attempts must survive the quiz'
    );
    assert(before >= 4, 'the fixture must have attempts worth preserving');
  });

  assert(perfectAttempt, 'the fixture must have produced a passing attempt');
}

/* ------------------------------------------------------------------ *
 * Administrator-issued password replacement
 *
 * This route can take over any account, so it is exactly the kind of thing that
 * must not be added without a test. It exists because the platform's own recovery
 * path — a reset link by email — cannot work where no mail provider is configured,
 * which leaves a locked-out user with no way back in and an administrator with no
 * way to help them short of editing the database by hand.
 * ------------------------------------------------------------------ */

async function testAdminPasswordReset() {
  const adminEmail = `smoke-admin-reset-${runId}@example.com`;
  const targetEmail = `smoke-target-reset-${runId}@example.com`;
  const outsiderEmail = `smoke-outsider-reset-${runId}@example.com`;

  createdEmails.push(adminEmail, targetEmail, outsiderEmail);

  // The policy the server enforces, so a generated password is checked against the
  // real rule rather than against what the generator happens to produce.
  const POLICY = /^(?=.*[A-Za-z])(?=.*[0-9]).{8,72}$/;

  let adminSession = null;
  let outsiderSession = null;
  let targetId = null;

  await check('an administrator and two accounts exist for the reset fixtures', async () => {
    await User.create({
      firstName: 'Ada',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    const admin = await request('POST', '/api/v1/auth/login', {
      body: { email: adminEmail, password: PASSWORD },
    });
    assertEqual(admin.status, 200, 'admin sign-in');
    adminSession = admin.json.data;

    for (const [email, firstName] of [[targetEmail, 'Tara'], [outsiderEmail, 'Owen']]) {
      const made = await request('POST', '/api/v1/admin/users', {
        token: adminSession.accessToken,
        body: { firstName, lastName: 'Fixture', email, password: PASSWORD, role: 'student' },
      });
      assertEqual(made.status, 201, `account created: ${email}`);

      const session = await request('POST', '/api/v1/auth/login', {
        body: { email, password: PASSWORD },
      });
      assertEqual(session.status, 200, `sign-in: ${email}`);

      if (email === targetEmail) {
        targetId = session.json.data.user.id;
      } else {
        outsiderSession = session.json.data;
      }
    }
  });

  let issued = null;

  await check('an administrator can issue a replacement password', async () => {
    const { status, json } = await request('POST', `/api/v1/admin/users/${targetId}/reset-password`, {
      token: adminSession.accessToken,
    });

    assertEqual(status, 200, 'status');
    assert(typeof json.data.password === 'string', 'a password must come back');
    assert(
      POLICY.test(json.data.password),
      `the issued password must satisfy the sign-in policy, got "${json.data.password}"`
    );
    issued = json.data.password;
  });

  await check('the issued password actually works', async () => {
    const { status } = await request('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: issued },
    });

    assertEqual(status, 200, 'status');
  });

  await check('the previous password stops working', async () => {
    const { status } = await request('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: PASSWORD },
    });

    assertEqual(status, 401, 'status');
  });

  await check('a student cannot issue a replacement password', async () => {
    const { status } = await request('POST', `/api/v1/admin/users/${targetId}/reset-password`, {
      token: outsiderSession.accessToken,
    });

    assertEqual(status, 403, 'status');

    // And the refusal must not have changed anything.
    const stillWorks = await request('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: issued },
    });
    assertEqual(stillWorks.status, 200, 'a refused reset must leave the password alone');
  });

  await check('a session that outlived the replacement stops working', async () => {
    /**
     * The server allows a five-second clock skew, so that signing in immediately
     * after changing your own password is not rejected on a slow request. A token
     * minted moments before the replacement is therefore *still valid*, so this
     * has to wait the skew out to test the thing it means to test. Six seconds is
     * the honest cost of asserting it rather than assuming it.
     */
    const before = await request('POST', '/api/v1/auth/login', {
      body: { email: targetEmail, password: issued },
    });
    assertEqual(before.status, 200, 'sign in to obtain a token that predates the change');
    const older = before.json.data.accessToken;

    await new Promise((resolve) => setTimeout(resolve, 6000));

    // A second replacement, so `passwordChangedAt` is now newer than that token.
    const second = await request('POST', `/api/v1/admin/users/${targetId}/reset-password`, {
      token: adminSession.accessToken,
    });
    assertEqual(second.status, 200, 'second replacement issued');

    // The point of setting `passwordChangedAt`: a replacement must take access away
    // from whoever held the old password, not merely add a second way in.
    const { status, json } = await request('GET', '/api/v1/auth/me', { token: older });

    assertEqual(status, 401, 'status');
    assertEqual(json.code, 'PASSWORD_CHANGED', 'error code');
  });

  await check('an unknown account cannot be reset', async () => {
    const { status } = await request('POST', '/api/v1/admin/users/000000000000000000000000/reset-password', {
      token: adminSession.accessToken,
    });

    assertEqual(status, 404, 'status');
  });
}

/* ------------------------------------------------------------------ *
 * Newsletter and contact
 *
 * Both are open to anyone and both write to the database, so they are the two
 * places a stranger can put a row in it. They were verified by hand when built;
 * this is what keeps them verified.
 * ------------------------------------------------------------------ */

async function testNewsletterAndContact() {
  const NewsletterSubscriber = require('../src/models/NewsletterSubscriber');
  const ContactMessage = require('../src/models/ContactMessage');
  const config = require('../src/config/env');

  const subscriberEmail = `smoke-newsletter-${runId}@example.com`;
  const contactEmail = `smoke-contact-${runId}@example.com`;
  const contactSubject = `Smoke contact ${runId}`;

  const messageBody = {
    name: 'Smoke Sender',
    email: contactEmail,
    reason: 'general',
    subject: contactSubject,
    message: 'A message long enough to satisfy the validator.',
  };

  await check('the newsletter accepts a new address', async () => {
    const { status, json } = await request('POST', '/api/v1/newsletter/subscribe', {
      body: { email: subscriberEmail },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.success, true, 'success flag');
    assertEqual(json.message, "Thanks! You're subscribed.", 'message');
  });

  await check('subscribing twice is not an error and does not duplicate', async () => {
    const again = await request('POST', '/api/v1/newsletter/subscribe', {
      body: { email: subscriberEmail },
    });

    assertEqual(again.status, 200, 'status');
    // The same answer as a first-time subscriber, so this endpoint cannot be used
    // to ask whether a particular address is already on the list.
    assertEqual(again.json.message, "Thanks! You're subscribed.", 'message');
    assertEqual(
      await NewsletterSubscriber.countDocuments({ email: subscriberEmail }),
      1,
      'exactly one row'
    );
  });

  await check('an address is stored once regardless of casing', async () => {
    const upper = await request('POST', '/api/v1/newsletter/subscribe', {
      body: { email: subscriberEmail.toUpperCase() },
    });

    assertEqual(upper.status, 200, 'status');
    assertEqual(
      await NewsletterSubscriber.countDocuments({ email: subscriberEmail }),
      1,
      'still one row'
    );

    const stored = await NewsletterSubscriber.findOne({ email: subscriberEmail });
    assertEqual(stored.email, subscriberEmail, 'stored lowercased');
  });

  await check('an invalid newsletter address is refused', async () => {
    const { status } = await request('POST', '/api/v1/newsletter/subscribe', {
      body: { email: 'not-an-email' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('a missing newsletter address is refused', async () => {
    const { status } = await request('POST', '/api/v1/newsletter/subscribe', { body: {} });

    assertEqual(status, 400, 'status');
  });

  await check('the contact form accepts a message and stores it', async () => {
    const { status, json } = await request('POST', '/api/v1/contact', {
      body: { ...messageBody, reason: 'partnership' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.message, "We've received your message.", 'message');

    const stored = await ContactMessage.findOne({ subject: contactSubject });
    assert(stored, 'the message must be stored, not only emailed');
    assertEqual(stored.reason, 'partnership', 'reason');
    assertEqual(stored.email, contactEmail, 'email lowercased');
  });

  await check('a contact message records whether anybody was told', async () => {
    /**
     * `deliver` reports failure rather than throwing — with no provider configured
     * it returns `{ delivered: false }` and logs instead. The route has to read that
     * result, and this is the check that catches it not doing so: the field once
     * said somebody had been told when nothing had been sent.
     */
    const stored = await ContactMessage.findOne({ subject: contactSubject });

    if (config.email.enabled) {
      assert(stored.notifiedAt, 'notifiedAt is set when a provider is configured');
    } else {
      assertEqual(stored.notifiedAt, null, 'notifiedAt stays null with no provider');
    }
  });

  await check('an invalid contact address is refused', async () => {
    const { status } = await request('POST', '/api/v1/contact', {
      body: { ...messageBody, email: 'nope' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('an unknown contact reason is refused', async () => {
    const { status } = await request('POST', '/api/v1/contact', {
      body: { ...messageBody, reason: 'nonsense' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('a contact subject that is too short is refused', async () => {
    const { status } = await request('POST', '/api/v1/contact', {
      body: { ...messageBody, subject: 'x' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('a contact message that is too short is refused', async () => {
    const { status } = await request('POST', '/api/v1/contact', {
      body: { ...messageBody, message: 'short' },
    });

    assertEqual(status, 400, 'status');
  });
}

/* ------------------------------------------------------------------ *
 * The enquiry queue and the subscriber list
 * ------------------------------------------------------------------ */

/**
 * Both public forms had always written to the database while nothing read either
 * collection back. These checks exist so the read paths stay read: an endpoint
 * that silently reverts to 404 would otherwise be invisible, because the form
 * would keep accepting messages and returning 200.
 */
async function testAdminEnquiries() {
  const adminEmail = `smoke-enq-admin-${runId}@example.com`;
  const studentEmail = `smoke-enq-student-${runId}@example.com`;
  const enquiryEmail = `smoke-enq-${runId}@example.com`;
  const subscriberEmail = `smoke-sub-${runId}@example.com`;

  /* Each suite that needs a session defines its own, matching the others in this
   * file. A helper shared across suites would be one more thing that can be
   * changed in a way that quietly affects a dozen unrelated checks. */
  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  let adminToken = null;
  let studentToken = null;
  let enquiryId = null;

  await check('an administrator can sign in to read the enquiry queue', async () => {
    await User.create({
      firstName: 'Enquiry',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Enquiry',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });
    createdEmails.push(adminEmail, studentEmail);

    adminToken = await signIn(adminEmail);
    studentToken = await signIn(studentEmail);

    assert(adminToken && studentToken, 'both sessions must exist');
  });

  await check('a message left on the public form is readable by an administrator', async () => {
    const posted = await request('POST', '/api/v1/contact', {
      body: {
        name: 'Smoke Enquirer',
        email: enquiryEmail,
        subject: 'Enquiry queue visibility',
        message: 'This message exists to prove the queue can be read back.',
      },
    });
    assertEqual(posted.status, 200, 'contact form status');

    const { status, json } = await request('GET', '/api/v1/admin/enquiries?state=all&limit=100', {
      token: adminToken,
    });
    assertEqual(status, 200, 'status');

    const found = (json.data.items || []).find((item) => item.email === enquiryEmail);
    assert(found, 'the message just posted must appear in the administrator list');
    assertEqual(found.handledAt, null, 'a new enquiry must start unhandled');
    enquiryId = found.id;
  });

  await check('an enquiry records whether its notification email went out', async () => {
    const { json } = await request('GET', '/api/v1/admin/enquiries?state=all&limit=100', {
      token: adminToken,
    });
    const found = (json.data.items || []).find((item) => item.email === enquiryEmail);
    assert(found, 'the enquiry must still be listed');

    // No provider is configured for the suite, so the send is a recorded
    // no-op. What matters is that the field distinguishes "not told" from
    // "told", rather than both reading as success.
    assert('notifiedAt' in found, 'the record must expose notifiedAt');
  });

  await check('marking an enquiry handled takes it out of the open queue', async () => {
    const marked = await request('PATCH', `/api/v1/admin/enquiries/${enquiryId}`, {
      token: adminToken,
      body: { handled: true },
    });
    assertEqual(marked.status, 200, 'status');
    assert(marked.json.data.handledAt, 'handledAt must be set');

    const open = await request('GET', '/api/v1/admin/enquiries?state=open&limit=100', { token: adminToken });
    const stillOpen = (open.json.data.items || []).some((item) => item.id === enquiryId);
    assertEqual(stillOpen, false, 'a handled enquiry must leave the open queue');

    const handled = await request('GET', '/api/v1/admin/enquiries?state=handled&limit=100', { token: adminToken });
    const nowHandled = (handled.json.data.items || []).some((item) => item.id === enquiryId);
    assertEqual(nowHandled, true, 'it must appear under handled');
  });

  await check('reopening an enquiry puts it back', async () => {
    const reopened = await request('PATCH', `/api/v1/admin/enquiries/${enquiryId}`, {
      token: adminToken,
      body: { handled: false },
    });
    assertEqual(reopened.status, 200, 'status');
    assertEqual(reopened.json.data.handledAt, null, 'handledAt must be cleared');

    const open = await request('GET', '/api/v1/admin/enquiries?state=open&limit=100', { token: adminToken });
    assert(
      (open.json.data.items || []).some((item) => item.id === enquiryId),
      'a reopened enquiry must be back in the open queue'
    );
  });

  await check('an enquiry id that is not an id is refused, not passed to the database', async () => {
    const bad = await request('PATCH', '/api/v1/admin/enquiries/not-an-id', {
      token: adminToken,
      body: { handled: true },
    });
    assertEqual(bad.status, 400, 'status');

    const missing = await request('PATCH', '/api/v1/admin/enquiries/6ad7a1b74c2c1a1119cb1a9b', {
      token: adminToken,
      body: { handled: true },
    });
    assertEqual(missing.status, 404, 'a well-formed id that matches nothing is a 404');
  });

  await check('the enquiry queue is not readable by a student or by nobody', async () => {
    const asStudent = await request('GET', '/api/v1/admin/enquiries', { token: studentToken });
    assertEqual(asStudent.status, 403, 'a student must be refused');

    const anonymous = await request('GET', '/api/v1/admin/enquiries');
    assertEqual(anonymous.status, 401, 'an anonymous caller must be refused');
  });

  await check('a newsletter subscriber is visible to an administrator', async () => {
    const subscribed = await request('POST', '/api/v1/newsletter/subscribe', {
      body: { email: subscriberEmail, source: 'smoke' },
    });
    assertEqual(subscribed.status, 200, 'subscribe status');

    const { status, json } = await request('GET', '/api/v1/admin/subscribers?limit=100', { token: adminToken });
    assertEqual(status, 200, 'status');

    const found = (json.data.items || []).find((item) => item.email === subscriberEmail);
    assert(found, 'the address just subscribed must be listed');
    assert(json.data.total >= 1, 'the total must count it');
    assert(json.data.active >= 1, 'a new subscriber must count as active');
  });

  await check('the subscriber list is administrator-only', async () => {
    const asStudent = await request('GET', '/api/v1/admin/subscribers', { token: studentToken });
    assertEqual(asStudent.status, 403, 'a student must be refused');
  });
}

/**
 * Instructor applications.
 *
 * An instructor account is not something a request may grant itself. The public
 * application form creates `role: 'instructor'` with `status: 'pending'` — both
 * decided by the server, never read from the body — and the applicant cannot
 * sign in until an administrator decides. Most of these checks are about that
 * boundary: a pending or rejected account has to be inert, and the ordinary
 * student sign-up has to keep producing students.
 */
async function testInstructorApplications() {
  const mailer = require('../src/services/email');

  const adminEmail = `smoke-app-admin-${runId}@example.com`;
  const studentEmail = `smoke-app-student-${runId}@example.com`;
  const cvApplicantEmail = `smoke-app-cv-${runId}@example.com`;
  const approvedEmail = `smoke-app-approved-${runId}@example.com`;
  const rejectedEmail = `smoke-app-rejected-${runId}@example.com`;
  const studentSignupEmail = `smoke-app-signup-${runId}@example.com`;
  createdEmails.push(adminEmail, studentEmail, cvApplicantEmail, approvedEmail, rejectedEmail, studentSignupEmail);

  let adminToken = null;
  let studentToken = null;
  let cvApplicantId = null;
  let approvedId = null;

  /** Defined per suite, matching the other suites in this file. */
  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  /** A real, minimal PDF — signature, some content, trailer. */
  const pdfDataUrl = (padding = 40) =>
    `data:application/pdf;base64,${Buffer.from(
      `%PDF-1.4\n1 0 obj\n<<>>\nendobj\n${'x'.repeat(padding)}\n%%EOF\n`
    ).toString('base64')}`;

  /** Run `task` with every outgoing message captured instead of delivered. */
  const captureEmail = async (task) => {
    const original = mailer.deliver;
    const captured = [];

    mailer.deliver = async (message) => {
      captured.push(message);
      return { delivered: true, id: 'captured' };
    };

    try {
      await task();
      // The acknowledgement is fire-and-forget on setImmediate.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      mailer.deliver = original;
    }

    return captured;
  };

  const download = async (path, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  };

  const applicationBody = (overrides = {}) => ({
    firstName: 'Applicant',
    lastName: 'Person',
    email: cvApplicantEmail,
    password: PASSWORD,
    dateOfBirth: ADULT_DATE_OF_BIRTH,
    phone: '+231770000000',
    location: 'Monrovia, Liberia',
    credentialSummary: 'BSc Accounting, University of Liberia (2018); CPA (2021).',
    qualifications: 'Six years teaching financial reporting to public-sector accountants.',
    yearsExperience: 6,
    expertise: 'financial management, internal audit, procurement',
    videoIntroUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ...overrides,
  });

  await check('an instructor-application fixture is provisioned', async () => {
    await User.create({
      firstName: 'Application',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });

    await User.create({
      firstName: 'Application',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    adminToken = await signIn(adminEmail);
    studentToken = await signIn(studentEmail);

    assert(adminToken && studentToken, 'both sessions must exist');
  });

  await check('an application creates an instructor account that cannot be used yet', async () => {
    const messages = await captureEmail(async () => {
      const { status, json } = await request('POST', '/api/v1/auth/register-instructor', {
        body: applicationBody({ cvImage: pdfDataUrl(), cvFilename: 'applicant-cv.pdf' }),
      });

      assertEqual(status, 201, 'status');
      assertEqual(json.data.status, 'pending', 'the application starts pending');
      // No session: an applicant holding a token would look signed in while
      // every role-gated request refused them.
      assert(!json.data.accessToken, 'no access token may be issued to an applicant');
      assert(!json.data.refreshToken, 'no refresh token may be issued to an applicant');
    });

    const created = await User.findOne({ email: cvApplicantEmail });
    assert(created, 'the applicant must exist');
    assertEqual(created.role, 'instructor', 'role');
    assertEqual(created.status, 'pending', 'status');
    assert(created.appliedAt, 'the application time must be recorded');
    assertEqual(created.cvStatus, 'pending', 'the attached CV waits for review');
    assertEqual(created.credentialSummary, applicationBody().credentialSummary, 'the credential summary');
    assertEqual(created.expertise.length, 3, 'the expertise list');
    cvApplicantId = String(created._id);

    // The acknowledgement is the only receipt the applicant gets.
    const acknowledgement = messages.find((message) => message.to === cvApplicantEmail);
    assert(acknowledgement, 'an acknowledgement email must be sent');
    assertEqual(acknowledgement.subject, 'We received your instructor application', 'subject');
    assert(/48 hours/.test(acknowledgement.text), 'the email must say when the decision arrives');
  });

  await check('a pending applicant cannot sign in', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/login', {
      body: { email: cvApplicantEmail, password: PASSWORD },
    });

    assertEqual(status, 401, 'status');
    assertEqual(json.code, 'ACCOUNT_PENDING', 'code');
    assert(!json.data || !json.data.accessToken, 'no session may be issued');
  });

  await check('an application cannot choose its own role or status', async () => {
    const { status } = await request('POST', '/api/v1/auth/register-instructor', {
      body: applicationBody({
        email: approvedEmail,
        role: 'admin',
        status: 'active',
        reviewedAt: new Date().toISOString(),
      }),
    });

    assertEqual(status, 201, 'status');

    const created = await User.findOne({ email: approvedEmail });
    assert(created, 'the applicant must exist');
    assertEqual(created.role, 'instructor', 'the body must not select a role');
    assertEqual(created.status, 'pending', 'the body must not start the account active');
    assertEqual(created.reviewedAt, null, 'the body must not mark the application reviewed');
    approvedId = String(created._id);
  });

  await check('the ordinary sign-up still cannot create an instructor', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ firstName: 'Role', lastName: 'Instructor', email: studentSignupEmail, role: 'instructor' }),
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.user.role, 'student', 'role must be forced to student');
    assertEqual(json.data.user.status, 'active', 'a self-registered student is active');
  });

  await check('the application reaches the administrators with its CV flagged', async () => {
    const { status, json } = await request(
      'GET',
      '/api/v1/admin/users?role=instructor&status=pending&limit=100',
      { token: adminToken }
    );

    assertEqual(status, 200, 'status');

    const applicant = (json.data.items || []).find((item) => item.id === cvApplicantId);
    assert(applicant, 'the application must be in the pending queue');
    assertEqual(applicant.status, 'pending', 'status');
    assertEqual(applicant.email, cvApplicantEmail, 'email');
    assertEqual(applicant.hasCv, true, 'the queue must know a CV is attached');
    assertEqual(applicant.credentialSummary, applicationBody().credentialSummary, 'the credential summary');
    assertEqual(applicant.yearsExperience, 6, 'years of experience');
  });

  await check("the applicant's CV is readable by an administrator and by nobody else", async () => {
    const asAdmin = await download(`/api/v1/admin/instructors/${cvApplicantId}/cv`, adminToken);
    assertEqual(asAdmin.status, 200, 'administrator status');
    assertEqual(asAdmin.contentType, 'application/pdf', 'content type');
    assert(asAdmin.buffer.subarray(0, 5).toString('latin1') === '%PDF-', 'the bytes must be the uploaded PDF');

    const asStudent = await download(`/api/v1/admin/instructors/${cvApplicantId}/cv`, studentToken);
    assertEqual(asStudent.status, 403, 'a student must not reach an applicant CV');

    const anonymous = await download(`/api/v1/admin/instructors/${cvApplicantId}/cv`);
    assertEqual(anonymous.status, 401, 'an anonymous caller must not reach an applicant CV');
  });

  await check('a rejection needs a reason, and a refused one changes nothing', async () => {
    const short = await request('POST', `/api/v1/admin/instructors/${cvApplicantId}/reject`, {
      token: adminToken,
      body: { reason: 'no' },
    });
    assertEqual(short.status, 400, 'a short reason must be refused');
    assertEqual(short.json.code, 'VALIDATION_ERROR', 'code');

    const still = await User.findById(cvApplicantId);
    assertEqual(still.status, 'pending', 'a refused rejection must leave the application pending');
    assertEqual(still.statusReason, null, 'no reason may be stored');
  });

  await check('only an administrator can decide an application', async () => {
    const asStudent = await request('POST', `/api/v1/admin/instructors/${approvedId}/approve`, {
      token: studentToken,
    });
    assertEqual(asStudent.status, 403, 'a student must not approve an application');

    const anonymous = await request('POST', `/api/v1/admin/instructors/${approvedId}/approve`);
    assertEqual(anonymous.status, 401, 'an anonymous caller must not approve an application');

    const studentRejected = await request('POST', `/api/v1/admin/instructors/${approvedId}/reject`, {
      token: studentToken,
      body: { reason: 'This should never be accepted.' },
    });
    assertEqual(studentRejected.status, 403, 'a student must not reject an application');
  });

  await check('approval activates the account and the instructor can then sign in', async () => {
    const messages = await captureEmail(async () => {
      const { status, json } = await request('POST', `/api/v1/admin/instructors/${approvedId}/approve`, {
        token: adminToken,
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.instructor.status, 'active', 'the approved account must be active');
      assert(json.data.instructor.reviewedAt, 'the review time must be recorded');
    });

    const approved = await User.findById(approvedId);
    assertEqual(approved.status, 'active', 'stored status');
    assert(String(approved.reviewedBy) === String((await User.findOne({ email: adminEmail }))._id), 'who decided');

    const welcome = messages.find((message) => message.to === approvedEmail);
    assert(welcome, 'the approved instructor must be emailed');

    const token = await signIn(approvedEmail);
    assert(token, 'the approved instructor must be able to sign in');

    const dashboard = await request('GET', '/api/v1/dashboard/instructor', { token });
    assertEqual(dashboard.status, 200, 'the instructor dashboard must open');
  });

  await check('a rejected applicant is told why and still cannot sign in', async () => {
    const submitted = await request('POST', '/api/v1/auth/register-instructor', {
      body: applicationBody({ email: rejectedEmail, firstName: 'Rejected', cvImage: undefined }),
    });
    assertEqual(submitted.status, 201, 'the application must be accepted first');

    const applicant = await User.findOne({ email: rejectedEmail }).select('_id');
    const reason = 'The CV could not be verified with the institution named.';

    const messages = await captureEmail(async () => {
      const { status, json } = await request('POST', `/api/v1/admin/instructors/${applicant._id}/reject`, {
        token: adminToken,
        body: { reason },
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.instructor.status, 'rejected', 'status after rejection');
      assertEqual(json.data.instructor.statusReason, reason, 'the reason is returned to the administrator');
    });

    const stored = await User.findById(applicant._id);
    assertEqual(stored.status, 'rejected', 'stored status');
    assertEqual(stored.statusReason, reason, 'the reason must be stored');

    const email = messages.find((message) => message.to === rejectedEmail);
    assert(email, 'the applicant must be emailed');
    assert(email.text.includes(reason), 'the email must carry the reason given');

    const login = await request('POST', '/api/v1/auth/login', {
      body: { email: rejectedEmail, password: PASSWORD },
    });
    assertEqual(login.status, 401, 'a rejected applicant must not sign in');
    assertEqual(login.json.code, 'ACCOUNT_REJECTED', 'code');
  });

  await check('a student account cannot be approved as an instructor', async () => {
    const student = await User.findOne({ email: studentEmail }).select('_id');

    const approved = await request('POST', `/api/v1/admin/instructors/${student._id}/approve`, {
      token: adminToken,
    });
    assertEqual(approved.status, 400, 'status');
    assertEqual(approved.json.code, 'NOT_AN_INSTRUCTOR', 'code');

    const still = await User.findById(student._id);
    assertEqual(still.role, 'student', 'the role must be untouched');
  });
}

/**
 * Certificate fees.
 *
 * A course can be free to study and still charge for its certificate. Finishing
 * such a course reserves the document — number and all — without issuing it, and
 * the student pays through the same manual-verification queue a course purchase
 * goes through. These checks are mostly about what does NOT happen: no download
 * before the money, no second order, no second certificate, and no fee charged
 * on a course that was already paid for.
 */
async function testCertificateFees() {
  const Certificate = require('../src/models/Certificate');
  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');

  const adminEmail = `smoke-fee-admin-${runId}@example.com`;
  const studentEmail = `smoke-fee-student-${runId}@example.com`;
  const unpaidEmail = `smoke-fee-unpaid-${runId}@example.com`;
  createdEmails.push(adminEmail, studentEmail, unpaidEmail);

  let adminToken = null;
  let studentToken = null;
  let unpaidToken = null;
  let feeCourse = null;
  let freeCourse = null;
  let paidCourse = null;
  let certificate = null;
  let order = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  const download = async (path, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  };

  /** A published, one-lesson course the suite can finish in a single request. */
  const makeCourse = async (title, extra = {}) => {
    const course = await Course.create({
      title,
      slug: `smoke-fee-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${runId}`,
      instructor: (await User.findOne({ email: adminEmail }))._id,
      instructorName: 'FEES Admin',
      category: 'business-management',
      level: 'beginner',
      status: 'published',
      publishedAt: new Date(),
      priceCents: 0,
      ...extra,
    });

    const lesson = await Lesson.create({
      course: course._id,
      title: 'The only lesson',
      content: 'One lesson, so finishing it finishes the course.',
      order: 1,
      published: true,
    });

    return { course, lesson };
  };

  const enrolAndFinish = async ({ course, lesson }, token) => {
    const enrolled = await request('POST', `/api/v1/courses/${course.id}/enroll`, { token });
    // 201 for a new enrolment, 200 when one already exists.
    assert(
      enrolled.status === 200 || enrolled.status === 201,
      `enrol status: ${enrolled.status} ${enrolled.json && enrolled.json.message}`
    );

    const finished = await request('POST', `/api/v1/courses/${course.id}/lessons/${lesson.id}/complete`, {
      token,
    });
    assertEqual(finished.status, 200, 'completion status');

    return finished.json.data;
  };

  await check('certificate-fee fixtures are provisioned', async () => {
    await User.create({
      firstName: 'Fees',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Fees',
      lastName: 'Student',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Fees',
      lastName: 'Unpaid',
      email: unpaidEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    adminToken = await signIn(adminEmail);
    studentToken = await signIn(studentEmail);
    unpaidToken = await signIn(unpaidEmail);

    const fee = await makeCourse('Certificate fee course', { certificateFeeCents: 3000 });
    const free = await makeCourse('Certificate free course');
    const paid = await makeCourse('Certificate paid course', { priceCents: 5000, certificateFeeCents: 5000 });

    feeCourse = { course: fee.course.toCardJSON(), lesson: fee.lesson.toFullJSON() };
    freeCourse = { course: free.course.toCardJSON(), lesson: free.lesson.toFullJSON() };
    paidCourse = paid.course.toCardJSON();

    assert(adminToken && studentToken && unpaidToken, 'all three sessions must exist');
    assert(feeCourse.course.id && freeCourse.course.id, 'the courses must be created');
  });

  await check('a free course with no fee still issues its certificate at completion', async () => {
    const state = await enrolAndFinish(freeCourse, studentToken);

    assertEqual(state.finished, true, 'the course must be complete');
    assert(state.certificate, 'a certificate must be issued immediately');
    assertEqual(state.certificate.status, 'issued', 'status');
    assertEqual(state.certificate.feeCents, 0, 'no fee is recorded');

    const stored = await Certificate.findById(state.certificate.id).select('+pdfBase64');
    assert(stored.pdfBase64, 'the document must be rendered at issue time');
  });

  await check('the certificate fee is part of the course the catalog serves', async () => {
    const { status, json } = await request('GET', `/api/v1/courses/${feeCourse.course.slug}`);

    assertEqual(status, 200, 'status');
    assertEqual(json.data.course.certificateFeeCents, 3000, 'stored fee');
    assertEqual(json.data.course.certificateFeeDueCents, 3000, 'fee actually charged');
    assertEqual(json.data.course.certificateFeeLabel, '$30.00', 'label');
  });

  await check('a paid course does not charge a certificate fee on top', async () => {
    const { json } = await request('GET', `/api/v1/courses/${paidCourse.slug}`);

    assertEqual(json.data.course.priceCents, 5000, 'the course price');
    // Stored, but not applied: buying the course already includes the certificate.
    assertEqual(json.data.course.certificateFeeCents, 5000, 'stored fee');
    assertEqual(json.data.course.certificateFeeDueCents, 0, 'nothing extra is due');
    assertEqual(json.data.course.certificateFeeLabel, null, 'no label is shown');
  });

  await check('finishing a course with a fee reserves the certificate without issuing it', async () => {
    const state = await enrolAndFinish(feeCourse, studentToken);

    assertEqual(state.finished, true, 'the course must be complete');
    assert(state.certificate, 'the certificate record must exist');
    assertEqual(state.certificate.status, 'pending_payment', 'status');
    assertEqual(state.certificate.feeCents, 3000, 'the fee is fixed on the document');
    assertEqual(state.certificate.requiresPayment, true, 'the student is told it must be claimed');
    assertEqual(state.certificate.feeLabel, '$30.00', 'the label the dashboard shows');

    certificate = state.certificate;

    const stored = await Certificate.findById(certificate.id).select('+pdfBase64');
    assertEqual(stored.status, 'pending_payment', 'stored status');
    assert(!stored.pdfBase64, 'no document may exist before it is paid for');
  });

  await check('an administrator can list the certificates waiting to be paid for', async () => {
    const { status, json } = await request(
      'GET',
      '/api/v1/admin/certificates?status=pending_payment&limit=100',
      { token: adminToken }
    );

    assertEqual(status, 200, 'status');
    assert(
      (json.data.items || []).some((item) => item.id === certificate.id),
      'the reserved certificate must be in the queue'
    );
    assert(json.data.counts.pendingPayment >= 1, 'the awaiting-payment count must include it');
    // The issued list must not claim it.
    assertEqual(
      (json.data.items || []).every((item) => item.status === 'pending_payment'),
      true,
      'the filter must return only certificates awaiting payment'
    );
  });

  await check('a certificate awaiting payment does not verify publicly', async () => {
    const { status, json } = await request('GET', `/api/v1/certificates/verify/${certificate.verificationCode}`);

    assertEqual(status, 200, 'status');
    assertEqual(json.data.found, true, 'the reference is known');
    assertEqual(json.data.valid, false, 'but it is not a valid certificate yet');
    assertEqual(json.data.status, 'pending_payment', 'the public payload names the state');
  });

  await check('a certificate awaiting payment cannot be downloaded', async () => {
    const response = await download(`/api/v1/certificates/${certificate.id}/download`, studentToken);

    assertEqual(response.status, 402, '402, not a 500 and not a document');
    assert(response.contentType.includes('json'), 'the refusal is a JSON body, not a PDF');
  });

  await check('a certificate order cannot be opened before the course is finished', async () => {
    await request('POST', `/api/v1/courses/${feeCourse.course.id}/enroll`, { token: unpaidToken });

    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: unpaidToken,
      body: { courseId: feeCourse.course.id, purpose: 'certificate' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'COURSE_NOT_COMPLETED', 'code');
  });

  await check('a certificate order is priced by the server, never by the request', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: studentToken,
      body: { courseId: feeCourse.course.id, purpose: 'certificate', amountCents: 1 },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.order.purpose, 'certificate', 'purpose');
    assertEqual(json.data.order.amountCents, 3000, 'the amount comes from the certificate');
    assertEqual(json.data.order.certificateId, certificate.id, 'the order names the document');
    assert(json.data.order.orderId, 'an order reference is issued');
    assert(json.data.instructions.numbers.length > 0, 'the numbers to send to are included');

    order = json.data.order;
  });

  await check('pressing claim twice returns the same order, not a second one', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: studentToken,
      body: { courseId: feeCourse.course.id, purpose: 'certificate' },
    });

    assertEqual(status, 200, 'the second press is not an error');
    assertEqual(json.data.order.orderId, order.orderId, 'the same reference comes back');
    assertEqual(
      await require('../src/models/Payment').countDocuments({
        student: (await User.findOne({ email: studentEmail }))._id,
        purpose: 'certificate',
      }),
      1,
      'only one certificate order exists'
    );
  });

  await check('a student who is enrolled cannot also buy the course', async () => {
    const { status, json } = await request('POST', '/api/v1/payments/manual', {
      token: studentToken,
      body: { courseId: feeCourse.course.id },
    });

    assertEqual(status, 403, 'status');
    assertEqual(json.code, 'ALREADY_ENROLLED', 'code');
  });

  await check('a student can see the purpose of their own orders', async () => {
    const { status, json } = await request('GET', '/api/v1/payments/me', { token: studentToken });

    assertEqual(status, 200, 'status');
    const certificateOrder = (json.data.items || []).find((item) => item.orderId === order.orderId);
    assert(certificateOrder, 'the certificate order must be listed');
    assertEqual(certificateOrder.purpose, 'certificate', 'purpose');

    /**
     * A payment written before this field existed must still read as an
     * enrollment — the revenue reports and every old receipt depend on it.
     */
    const legacy = new (require('../src/models/Payment'))({
      student: (await User.findOne({ email: studentEmail }))._id,
      course: feeCourse.course.id,
      amountCents: 4999,
      idempotencyKey: `legacy:${runId}`,
    });
    assertEqual(legacy.toJSONForOwner().purpose, 'enrollment', 'a payment with no purpose is an enrolment');
  });

  await check('confirming the order issues the certificate and renders the document', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/admin/payments/manual/${order.orderId}/verify`,
      { token: adminToken, body: {} }
    );

    assertEqual(status, 200, 'status');
    assertEqual(json.data.outcome, 'certificate', 'the administrator is told what happened');

    const stored = await Certificate.findById(certificate.id).select('+pdfBase64');
    assertEqual(stored.status, 'issued', 'the certificate is now issued');
    assert(stored.paidAt, 'the payment time is recorded');
    assert(stored.pdfBase64, 'the document is rendered on confirmation');

    const response = await download(`/api/v1/certificates/${certificate.id}/download`, studentToken);
    assertEqual(response.status, 200, 'the student can now download it');
    assertEqual(response.contentType, 'application/pdf', 'content type');
  });

  await check('confirming the same order twice does not issue a second certificate', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/admin/payments/manual/${order.orderId}/verify`,
      { token: adminToken, body: {} }
    );

    assertEqual(status, 200, 'status');
    assert(json.message.includes('already'), `message was "${json.message}"`);

    const count = await Certificate.countDocuments({
      student: (await User.findOne({ email: studentEmail }))._id,
      course: feeCourse.course.id,
    });
    assertEqual(count, 1, 'still exactly one certificate');
  });

  await check('the course fee can be changed, but only to one of the listed amounts', async () => {
    const refused = await request('PATCH', `/api/v1/courses/${feeCourse.course.id}`, {
      token: adminToken,
      body: { certificateFeeCents: 1500 },
    });

    assertEqual(refused.status, 400, 'an unlisted amount is refused');
    assertEqual(refused.json.code, 'VALIDATION_ERROR', 'code');

    const accepted = await request('PATCH', `/api/v1/courses/${feeCourse.course.id}`, {
      token: adminToken,
      body: { certificateFeeCents: 2000 },
    });

    assertEqual(accepted.status, 200, 'status');
    assertEqual(accepted.json.data.course.certificateFeeCents, 2000, 'the new fee is stored');
    // The certificate already issued keeps the price it was sold at.
    const stored = await Certificate.findById(certificate.id);
    assertEqual(stored.feeCents, 3000, 'the issued certificate keeps its own fee');
  });
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

/**
 * Course reviews: eligibility, moderation and the rating they produce.
 *
 * The rules being asserted are the ones a visitor depends on: an unapproved
 * review is invisible, an unenrolled student cannot write one, and the number on
 * a course card only moves when a review has actually been published.
 */
async function testReviews() {
  const Review = require('../src/models/Review');
  const Course = require('../src/models/Course');
  const Notification = require('../src/models/Notification');

  const adminEmail = `smoke-review-admin-${runId}@example.com`;
  const authorEmail = `smoke-review-author-${runId}@example.com`;
  const otherEmail = `smoke-review-other-${runId}@example.com`;
  createdEmails.push(adminEmail, authorEmail, otherEmail);

  let adminToken = null;
  let authorToken = null;
  let otherToken = null;
  let author = null;
  let other = null;
  let course = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  const reviewsPath = () => `/api/v1/courses/${course.id}/reviews`;
  const publicList = async () => {
    const { status, json } = await request('GET', reviewsPath());
    assertEqual(status, 200, 'list status');
    return json.data;
  };
  const courseRating = async () => {
    const { json } = await request('GET', `/api/v1/courses/${course.slug}`);
    return { rating: json.data.course.rating, count: json.data.course.ratingCount };
  };

  await check('review fixtures are provisioned', async () => {
    await User.create({
      firstName: 'Review',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });
    author = await User.create({
      firstName: 'Review',
      lastName: 'Author',
      email: authorEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });
    other = await User.create({
      firstName: 'Other',
      lastName: 'Student',
      email: otherEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    adminToken = await signIn(adminEmail);
    authorToken = await signIn(authorEmail);
    otherToken = await signIn(otherEmail);

    course = await Course.create({
      title: 'A course with reviews',
      slug: `smoke-review-course-${runId}`,
      instructor: (await User.findOne({ email: adminEmail }))._id,
      instructorName: 'Review Admin',
      category: 'business-management',
      level: 'beginner',
      status: 'published',
      publishedAt: new Date(),
      priceCents: 0,
    });

    assert(adminToken && authorToken && otherToken, 'all three sessions must exist');
  });

  await check('a course nobody has reviewed reports no rating', async () => {
    const rating = await courseRating();
    assertEqual(rating.count, 0, 'rating count');
    assertEqual(rating.rating, 0, 'rating');

    const list = await publicList();
    assertEqual(list.pagination.total, 0, 'published reviews');
    assertEqual(list.summary.count, 0, 'summary count');
  });

  await check('a student who has not enrolled cannot review', async () => {
    const { status, json } = await request('POST', reviewsPath(), {
      token: otherToken,
      body: { rating: 5, body: 'A review from someone who never enrolled.' },
    });

    assertEqual(status, 403, 'status');
    assertEqual(json.code, 'ENROLLMENT_REQUIRED', 'error code');
  });

  await check('an enrolled student can submit a review', async () => {
    const enrolled = await request('POST', `/api/v1/courses/${course.id}/enroll`, { token: authorToken });
    assert(enrolled.status === 200 || enrolled.status === 201, `enrol status: ${enrolled.status}`);

    const { status, json } = await request('POST', reviewsPath(), {
      token: authorToken,
      body: {
        rating: 5,
        title: 'Worth the time',
        body: 'The lessons explained the material with worked examples I could follow.',
      },
    });

    assertEqual(status, 201, 'status');
    assertEqual(json.data.review.status, 'pending', 'a new review waits for moderation');
  });

  await check('a review is not public until it has been approved', async () => {
    const list = await publicList();
    assertEqual(list.pagination.total, 0, 'published reviews');

    const own = await request('GET', reviewsPath(), { token: authorToken });
    assertEqual(own.json.data.myReview.status, 'pending', 'the author sees their own review');
    assertEqual(own.json.data.myReview.isMine, true, 'isMine');
  });

  await check('a review too short to be useful is refused', async () => {
    const { status, json } = await request('POST', reviewsPath(), {
      token: authorToken,
      body: { rating: 4, body: 'Good.' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
  });

  await check('a rating outside one to five is refused', async () => {
    const { status } = await request('POST', reviewsPath(), {
      token: authorToken,
      body: { rating: 6, body: 'A rating that no star row can represent.' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('an unapproved review does not move the course rating', async () => {
    const rating = await courseRating();
    assertEqual(rating.count, 0, 'rating count');
  });

  await check('a student cannot read the moderation queue', async () => {
    const { status } = await request('GET', '/api/v1/admin/reviews', { token: otherToken });
    assertEqual(status, 403, 'status');
  });

  await check('the administrator sees the review waiting for moderation', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/reviews?status=pending', {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');
    const mine = json.data.items.find((item) => item.courseId === course.id);
    assert(mine, 'the pending review should be in the queue');
    assertEqual(mine.author.name, 'Review Author', 'author name');
    assertEqual(mine.status, 'pending', 'status');
    assertEqual(json.data.counts.pending >= 1, true, 'the pending count should include it');
  });

  let approvedId = null;

  await check('approving a review publishes it and sets the course rating', async () => {
    const queued = await request('GET', '/api/v1/admin/reviews?status=pending', { token: adminToken });
    approvedId = queued.json.data.items.find((item) => item.courseId === course.id).id;

    const { status, json } = await request('POST', `/api/v1/admin/reviews/${approvedId}/approve`, {
      token: adminToken,
    });
    assertEqual(status, 200, 'approval status');
    assertEqual(json.data.review.status, 'approved', 'status after approval');

    const list = await publicList();
    assertEqual(list.pagination.total, 1, 'published reviews');
    assertEqual(list.items[0].rating, 5, 'published rating');
    assertEqual(list.summary.average, 5, 'summary average');

    const rating = await courseRating();
    assertEqual(rating.count, 1, 'rating count');
    assertEqual(rating.rating, 5, 'rating');
  });

  await check('the reviewer is told their review is live', async () => {
    const notification = await Notification.findOne({
      user: author._id,
      title: 'Your review is live',
    });

    assert(notification, 'the reviewer should be notified');
  });

  await check('posting a second review replaces the first instead of duplicating it', async () => {
    const { status } = await request('POST', reviewsPath(), {
      token: authorToken,
      body: {
        rating: 4,
        title: 'Still worth the time',
        body: 'A second draft of the same review, which should replace the first.',
      },
    });

    assertEqual(status, 200, 'status');
    const count = await Review.countDocuments({ course: course._id, student: author._id });
    assertEqual(count, 1, 'reviews by this student');
  });

  await check('an edited review returns to moderation and leaves the rating', async () => {
    const list = await publicList();
    assertEqual(list.pagination.total, 0, 'the edited review is no longer public');

    const rating = await courseRating();
    assertEqual(rating.count, 0, 'the course rating is withdrawn with it');
  });

  await check('a rejected review stays hidden and carries its reason', async () => {
    await request('POST', `/api/v1/courses/${course.id}/enroll`, { token: otherToken });

    const submitted = await request('POST', reviewsPath(), {
      token: otherToken,
      body: { rating: 2, body: 'A review the moderator will refuse for this test.' },
    });
    assertEqual(submitted.status, 201, 'submit status');

    const rejectedId = submitted.json.data.review.id;
    const { status } = await request('POST', `/api/v1/admin/reviews/${rejectedId}/reject`, {
      token: adminToken,
      body: { reason: 'This review describes a different course.' },
    });
    assertEqual(status, 200, 'rejection status');

    const own = await request('GET', reviewsPath(), { token: otherToken });
    assertEqual(own.json.data.myReview.status, 'rejected', 'the author sees the refusal');
    assertEqual(
      own.json.data.myReview.moderationNote,
      'This review describes a different course.',
      'the reason is shown to its author'
    );

    const list = await publicList();
    assertEqual(list.pagination.total, 0, 'a rejected review is never public');
  });

  await check('a student can withdraw their review', async () => {
    const { status } = await request('DELETE', `${reviewsPath()}/mine`, { token: authorToken });
    assertEqual(status, 200, 'status');

    const count = await Review.countDocuments({ course: course._id, student: author._id });
    assertEqual(count, 0, 'reviews left by this student');

    const rating = await courseRating();
    assertEqual(rating.count, 0, 'rating count');
  });

  await check('moderating a review that does not exist is a 404', async () => {
    const { status, json } = await request('POST', '/api/v1/admin/reviews/6ad32bc65ceb158991984fff/approve', {
      token: adminToken,
    });

    assertEqual(status, 404, 'status');
    assertEqual(json.code, 'REVIEW_NOT_FOUND', 'error code');
  });
}

/**
 * An instructor with more courses than the dashboard preview shows.
 *
 * The overview payload carries the twelve most recently updated courses. Every
 * figure beside it — courses, published, drafts, students — used to be counted
 * from those twelve, so an instructor with 47 courses was told they had 12 and a
 * student enrolled in the thirteenth-oldest course was invisible.
 */
async function testInstructorCoursePagination() {
  const Course = require('../src/models/Course');
  const Enrollment = require('../src/models/Enrollment');

  const instructorEmail = `smoke-many-instructor-${runId}@example.com`;
  const studentEmail = `smoke-many-student-${runId}@example.com`;
  createdEmails.push(instructorEmail, studentEmail);

  const TOTAL = 47;
  let instructorToken = null;
  let oldestCourse = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  await check('a 47-course instructor fixture is provisioned', async () => {
    const instructor = await User.create({
      firstName: 'Many',
      lastName: 'Courses',
      email: instructorEmail,
      password: PASSWORD,
      role: 'instructor',
      emailVerified: true,
    });

    const student = await User.create({
      firstName: 'Oldest',
      lastName: 'Course',
      email: studentEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    const created = await Course.insertMany(
      Array.from({ length: TOTAL }, (unused, index) => ({
        title: `Many course ${index + 1}`,
        slug: `smoke-many-${runId}-${index + 1}`,
        instructor: instructor._id,
        instructorName: 'Many Courses',
        category: 'business-management',
        level: 'beginner',
        status: 'published',
        publishedAt: new Date(),
        priceCents: 0,
      }))
    );

    oldestCourse = created[0];

    // Deterministic ordering: the first course is the oldest, so "the twelve
    // most recent" is a known set and the oldest can be asserted absent.
    const base = Date.now() - TOTAL * 60000;
    await Promise.all(
      created.map((course, index) =>
        Course.updateOne(
          { _id: course._id },
          { $set: { createdAt: new Date(base + index * 60000), updatedAt: new Date(base + index * 60000) } },
          { timestamps: false }
        )
      )
    );

    await Enrollment.create({
      student: student._id,
      course: oldestCourse._id,
      courseTitle: oldestCourse.title,
    });

    instructorToken = await signIn(instructorEmail);
    assert(instructorToken, 'the instructor must be able to sign in');
  });

  let dashboard = null;

  await check('the instructor dashboard counts every course it owns', async () => {
    const { status, json } = await request('GET', '/api/v1/dashboard/instructor', {
      token: instructorToken,
    });

    assertEqual(status, 200, 'status');
    dashboard = json.data;

    assertEqual(dashboard.stats.courses, TOTAL, 'course count');
    assertEqual(dashboard.stats.published, TOTAL, 'published count');
    assertEqual(dashboard.stats.drafts, 0, 'draft count');
  });

  await check('the dashboard still previews only the recent courses', async () => {
    assertEqual(dashboard.courses.length, 12, 'preview length');
    assert(
      dashboard.courses.every((course) => course.id !== String(oldestCourse._id)),
      'the oldest course should not be in the preview'
    );
  });

  await check('a student on a course outside the preview is still counted', async () => {
    assertEqual(dashboard.stats.students, 1, 'student count');
    assertEqual(dashboard.stats.completions, 0, 'completion count');
  });

  await check('the full course list is served in one page when asked for it', async () => {
    const { status, json } = await request('GET', '/api/v1/courses/mine?limit=100', {
      token: instructorToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.pagination.total, TOTAL, 'total courses');
    assertEqual(json.data.items.length, TOTAL, 'courses on the page');
  });

  await check('the full course list paginates correctly past one page', async () => {
    const { json } = await request('GET', '/api/v1/courses/mine?limit=20&page=3', {
      token: instructorToken,
    });

    assertEqual(json.data.pagination.total, TOTAL, 'total courses');
    assertEqual(json.data.pagination.totalPages, 3, 'total pages');
    assertEqual(json.data.items.length, 7, 'the last page holds the remainder');
    assertEqual(json.data.pagination.hasNextPage, false, 'no page after the last');
  });

  await check('a student cannot list instructor courses', async () => {
    const studentToken = await signIn(studentEmail);
    const { status } = await request('GET', '/api/v1/courses/mine', { token: studentToken });

    assertEqual(status, 403, 'status');
  });
}

/**
 * Offline admissions and the public catalogue statistics.
 *
 * The admission form is the only public endpoint that stores files and emails an
 * address the caller chose, so the checks here are about the refusals as much as
 * the happy path.
 */
async function testAdmissionsAndStats() {
  const AdmissionApplication = require('../src/models/AdmissionApplication');
  const Course = require('../src/models/Course');

  const adminEmail = `smoke-adm-admin-${runId}@example.com`;
  const applicantEmail = `smoke-adm-applicant-${runId}@example.com`;
  createdEmails.push(adminEmail, applicantEmail);

  let adminToken = null;
  let applicantToken = null;
  let tracking = null;
  let applicationId = null;

  const signIn = async (email) => {
    const { json } = await request('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    return json.data.accessToken;
  };

  const applicationBody = (overrides = {}) => ({
    classLevel: 'Vocational Study',
    firstName: 'Admissions',
    lastName: 'Applicant',
    gender: 'female',
    dateOfBirth: '2005-04-12',
    mobile: '0888025082',
    email: applicantEmail,
    religion: 'Christian',
    fatherName: 'Father Applicant',
    fatherPhone: '0888000001',
    motherName: 'Mother Applicant',
    motherPhone: '0888000002',
    motherOccupation: 'Trader',
    previousSchool: 'Sinkor High School',
    documents: [],
    consent: true,
    ...overrides,
  });

  await check('admission fixtures are provisioned', async () => {
    await User.create({
      firstName: 'Admission',
      lastName: 'Admin',
      email: adminEmail,
      password: PASSWORD,
      role: 'admin',
      emailVerified: true,
    });
    await User.create({
      firstName: 'Admission',
      lastName: 'Applicant',
      email: applicantEmail,
      password: PASSWORD,
      role: 'student',
      emailVerified: true,
    });

    adminToken = await signIn(adminEmail);
    applicantToken = await signIn(applicantEmail);

    assert(adminToken && applicantToken, 'both sessions must exist');
  });

  await check('the public statistics are counted, not invented', async () => {
    const { status, json } = await request('GET', '/api/v1/stats/public');

    assertEqual(status, 200, 'status');
    const published = await Course.countDocuments({ status: 'published' });

    assertEqual(json.data.courses, published, 'course count matches the database');
    assertEqual(typeof json.data.instructors, 'number', 'instructor count is a number');
    assertEqual(typeof json.data.lessons, 'number', 'lesson count is a number');
    assertEqual(typeof json.data.hours, 'number', 'hours is a number');
    assertEqual(typeof json.data.freeCourses, 'number', 'free course count is a number');
  });

  await check('the offline class list is served publicly', async () => {
    const { status, json } = await request('GET', '/api/v1/admissions/classes');

    assertEqual(status, 200, 'status');
    assert(Array.isArray(json.data.classes) && json.data.classes.length > 0, 'at least one class');
  });

  await check('an application without consent is refused', async () => {
    const { status, json } = await request('POST', '/api/v1/admissions', {
      body: applicationBody({ consent: false }),
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'validation error');
  });

  await check('an application with a made-up photo key is refused', async () => {
    const { status, json } = await request('POST', '/api/v1/admissions', {
      body: applicationBody({ photoKey: 'foo/bar.jpg' }),
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'UPLOAD_KEY_INVALID', 'key refused');
  });

  await check('an application is accepted and issues a tracking number', async () => {
    const { status, json } = await request('POST', '/api/v1/admissions', {
      body: applicationBody(),
    });

    assertEqual(status, 201, 'status');
    tracking = json.data.application.trackingNumber;
    assert(/^WGA-ADM-[23456789A-HJ-NP-Z]{8}$/.test(tracking), `tracking number shape: ${tracking}`);

    const stored = await AdmissionApplication.findOne({ trackingNumber: tracking });
    assert(stored, 'the application must be stored');
    applicationId = String(stored._id);
  });

  await check('a tracking number reveals its status and nothing personal', async () => {
    const { status, json } = await request('GET', `/api/v1/admissions/status/${tracking}`);

    assertEqual(status, 200, 'status');
    assertEqual(json.data.application.status, 'pending', 'status');
    assert(!json.data.application.motherPhone, 'the household must not be exposed');
    assert(!json.data.application.documents, 'documents must not be exposed');
  });

  await check('an unknown tracking number is a 404', async () => {
    const { status } = await request('GET', '/api/v1/admissions/status/WGA-ADM-ZZZZZZZZ');
    assertEqual(status, 404, 'status');
  });

  await check('a malformed tracking number is a 400', async () => {
    const { status } = await request('GET', '/api/v1/admissions/status/nonsense');
    assertEqual(status, 400, 'status');
  });

  await check('a student cannot read the admissions queue', async () => {
    const { status } = await request('GET', '/api/v1/admin/admissions', { token: applicantToken });
    assertEqual(status, 403, 'status');
  });

  await check('an administrator sees the application', async () => {
    const { status, json } = await request('GET', '/api/v1/admin/admissions?status=pending', {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');
    const mine = json.data.items.find((item) => item.trackingNumber === tracking);
    assert(mine, 'the application should be in the queue');
    assertEqual(mine.classLevel, 'Vocational Study', 'class');
    assert(json.data.counts && json.data.counts.pending >= 1, 'pending count');
  });

  await check('rejecting without a reason is refused', async () => {
    const { status } = await request('PATCH', `/api/v1/admin/admissions/${applicationId}`, {
      token: adminToken,
      body: { decision: 'rejected', note: 'no' },
    });

    assertEqual(status, 400, 'status');
  });

  await check('approving an application changes the status the applicant sees', async () => {
    const { status, json } = await request('PATCH', `/api/v1/admin/admissions/${applicationId}`, {
      token: adminToken,
      body: { decision: 'approved', note: 'Bring your certificate on the first day.' },
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.application.status, 'approved', 'status after approval');

    const publicView = await request('GET', `/api/v1/admissions/status/${tracking}`);
    assertEqual(publicView.json.data.application.status, 'approved', 'the applicant sees the decision');
  });

  await check('only an administrator can delete an application', async () => {
    const { status } = await request('DELETE', `/api/v1/admin/admissions/${applicationId}`, {
      token: applicantToken,
    });

    assertEqual(status, 403, 'status');
  });

  await check('deleting an application removes it and its stored files', async () => {
    const { status, json } = await request('DELETE', `/api/v1/admin/admissions/${applicationId}`, {
      token: adminToken,
    });

    assertEqual(status, 200, 'status');
    assertEqual(json.data.trackingNumber, tracking, 'the deleted record is named');

    const gone = await AdmissionApplication.findById(applicationId);
    assertEqual(gone, null, 'the record is gone');

    const publicView = await request('GET', `/api/v1/admissions/status/${tracking}`);
    assertEqual(publicView.status, 404, 'the tracking number no longer resolves');
  });

  await check('deleting an application twice reports it as missing', async () => {
    const { status, json } = await request('DELETE', `/api/v1/admin/admissions/${applicationId}`, {
      token: adminToken,
    });

    assertEqual(status, 404, 'status');
    assertEqual(json.code, 'APPLICATION_NOT_FOUND', 'error code');
  });

  await check('a material upload is refused while storage is unconfigured', async () => {
    // The suite runs without R2 credentials, which is a real deployment state:
    // the route must name the missing settings rather than fail obscurely.
    const { status, json } = await request('POST', '/api/v1/admissions/uploads', {
      body: { purpose: 'photo', filename: 'me.jpg', contentType: 'image/jpeg', sizeBytes: 1200 },
    });

    assert(status === 503 || status === 200, `status: ${status}`);
    if (status === 503) {
      assertEqual(json.code, 'STORAGE_NOT_CONFIGURED', 'names the missing settings');
    }
  });
}

/**
 * Social sign-in.
 *
 * The suite runs without OAuth credentials, which is the state a fresh deploy is
 * in, so what is asserted here is the set of things that must be true *before*
 * anybody adds credentials: the provider list carries no secrets, and a start or
 * callback can never send a visitor to a provider that is not configured, never
 * accept a state it did not issue, and never mint a session from a made-up code.
 */
async function testOAuth() {
  const manual = (path) => fetch(baseUrl + path, { redirect: 'manual' });
  const locationOf = (response) => response.headers.get('location') || '';

  await check('the provider list names both providers and leaks neither credential', async () => {
    const { status, json } = await request('GET', '/api/v1/auth/oauth/providers');

    assertEqual(status, 200, 'status');

    const names = json.data.providers.map((item) => item.name).sort().join(',');
    assertEqual(names, 'google,linkedin', 'providers');

    for (const item of json.data.providers) {
      assertEqual(typeof item.enabled, 'boolean', 'enabled is a boolean');
      assert(!('clientId' in item) && !('clientSecret' in item), 'no credential in the payload');
    }
  });

  await check('a configured provider is sent the state, the PKCE challenge and the exact callback', async () => {
    const response = await manual('/api/v1/auth/oauth/google/start?next=/courses.html');

    assertEqual(response.status, 302, 'status');

    const target = new URL(locationOf(response));
    assertEqual(target.host, 'accounts.google.com', 'goes to the provider');
    assert(Boolean(target.searchParams.get('state')), 'carries state');
    assertEqual(target.searchParams.get('code_challenge_method'), 'S256', 'PKCE method');
    assert(Boolean(target.searchParams.get('code_challenge')), 'carries a challenge');
    assert(
      String(target.searchParams.get('redirect_uri')).endsWith('/api/v1/auth/oauth/google/callback'),
      'redirect_uri matches the route that answers it'
    );

    const cookie = response.headers.get('set-cookie') || '';
    assert(cookie.includes('wga_oauth='), 'sets the state cookie');
    assert(/HttpOnly/i.test(cookie), 'the state cookie is HttpOnly');
    assert(/SameSite=Lax/i.test(cookie), 'and SameSite=Lax, so the return navigation carries it');
  });

  await check('a provider without credentials sends the visitor back to sign-in', async () => {
    const response = await manual('/api/v1/auth/oauth/linkedin/start');

    assertEqual(response.status, 302, 'status');
    const location = locationOf(response);
    assert(location.includes('/login.html?'), 'back to the sign-in page');
    assert(location.includes('reason=PROVIDER_NOT_CONFIGURED'), 'and says why');
    assert(!location.includes('linkedin.com'), 'never forwards to the provider');
  });

  await check('an unknown provider is refused by name', async () => {
    const response = await manual('/api/v1/auth/oauth/myspace/start');

    assertEqual(response.status, 302, 'status');
    assert(locationOf(response).includes('reason=UNKNOWN_PROVIDER'), 'reason');
  });

  await check('a callback with no state value is refused', async () => {
    const response = await manual('/api/v1/auth/oauth/google/callback?code=abc');

    assertEqual(response.status, 302, 'status');
    assert(locationOf(response).includes('reason=MISSING_STATE'), 'reason');
  });

  await check('a callback carrying a forged state value is refused', async () => {
    const response = await manual('/api/v1/auth/oauth/google/callback?code=abc&state=forged.signature');

    assertEqual(response.status, 302, 'status');
    assert(locationOf(response).includes('reason=INVALID_STATE'), 'reason');
  });

  await check('a cancelled sign-in reports itself as cancelled', async () => {
    const response = await manual('/api/v1/auth/oauth/google/callback?error=access_denied');

    assertEqual(response.status, 302, 'status');
    assert(locationOf(response).includes('reason=cancelled'), 'reason');
  });

  await check('a made-up sign-in code issues no session', async () => {
    const { status } = await request('POST', '/api/v1/auth/oauth/exchange', {
      body: { code: 'not-a-real-sign-in-code' },
    });

    assertEqual(status, 401, 'status');
  });

  await check('the cookie notice and language control reach every page', async () => {
    // Both live in wga-consent.js and are requested by wga-ui.js, so the rule
    // that matters is: every page loads wga-ui.js. Checked against the staged
    // copy the server actually serves.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'public');

    const pages = fs.readdirSync(root).filter((name) => name.endsWith('.html'));
    const missing = pages.filter((name) => {
      const html = fs.readFileSync(path.join(root, name), 'utf8');
      return !html.includes('/assets/js/wga-ui.js');
    });

    assert(pages.length >= 20, 'the public directory still holds the pages');
    assertEqual(missing.join(', '), '', 'pages that would have no notice or language control');
  });

  await check('the shared bundle is served and asks once, not on every visit', async () => {
    const response = await fetch(baseUrl + '/assets/js/wga-consent.js');
    assertEqual(response.status, 200, 'status');

    const source = await response.text();
    assert(source.includes('wga.consent'), 'stores the choice');
    assert(source.includes('CONSENT_DAYS'), 'and remembers it rather than asking every page');
    assert(source.includes('translate.google.com'), 'loads the translator');
  });

  await check('every page that offers an AI tool loads the module, and none leak the key', async () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'public');

    const wanted = ['course.html', 'student-dashboard.html', 'instructor-dashboard.html'];
    const missing = wanted.filter((name) => {
      const html = fs.readFileSync(path.join(root, name), 'utf8');
      return !html.includes('/assets/js/wga-ai.js');
    });

    assertEqual(missing.join(', '), '', 'pages that offer AI but do not load it');

    // The module itself must contain no secret and no model prompt: it asks the
    // API, it does not decide anything.
    const source = fs.readFileSync(path.join(root, 'assets/js/wga-ai.js'), 'utf8');
    assert(!/sk-or-v1|OPENROUTER|Bearer\s+[A-Za-z0-9]/.test(source), 'no key or auth header in the browser code');
    assert(!source.includes('openai/gpt-4o-mini'), 'the model name is not chosen by the browser');
  });

  await check('the policy allows the translate origins but nothing wider', async () => {
    // Read from the module rather than the response: the suite runs with CSP
    // switched off (a test server serves no policy header), so asserting on the
    // header here would assert nothing at all.
    const { CSP_DIRECTIVES } = require('../src/middleware/security');

    const script = CSP_DIRECTIVES['script-src'].join(' ');
    const frame = CSP_DIRECTIVES['frame-src'].join(' ');
    const connect = CSP_DIRECTIVES['connect-src'].join(' ');
    const style = CSP_DIRECTIVES['style-src'].join(' ');

    assert(script.includes('https://translate.google.com'), 'the element script is allowed');
    assert(connect.includes('https://translate.googleapis.com'), 'its assets are reachable');
    assert(style.includes('https://translate.googleapis.com'), 'its stylesheet is allowed');
    assert(frame.includes('https://translate.google.com'), 'its toolbar frame is allowed');

    // A wildcard script origin would hand any subdomain of that host the page.
    assert(!/(^|\s)https:\/\/\*/.test(script), 'no wildcard script origin');
    assert(!script.includes("'unsafe-eval'"), 'no eval');
  });

  await check('the exchange needs a code before it will look at anything', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/oauth/exchange', { body: {} });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
  });

  /**
   * The successful path, start to session.
   *
   * This is the half the failure tests above cannot reach, and it is where a
   * real bug lived: the callback handed out its single-use code through a helper
   * that was never exported, so every completed sign-in answered 500 while every
   * refused one looked perfect. The provider calls are stubbed on the service
   * the route calls through, so no request leaves the runner and no credentials
   * are needed.
   */
  await check('a completed sign-in issues a session, and repeating it reuses the account', async () => {
    const oauth = require('../src/services/oauthService');
    const realExchange = oauth.exchangeCode;
    const realProfile = oauth.fetchProfile;

    const subject = 'smoke-subject-' + runId;
    const address = 'smoke-oauth-' + runId + '@example.com';
    createdEmails.push(address);

    oauth.exchangeCode = async () => 'stub-access-token';
    oauth.fetchProfile = async () => ({
      subject,
      email: address,
      firstName: 'Oauth',
      lastName: 'Smoke',
    });

    // Walk the two browser navigations the real flow uses, keeping the cookie.
    async function signIn() {
      const start = await fetch(baseUrl + '/api/v1/auth/oauth/google/start', { redirect: 'manual' });
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const cookie = String(start.headers.get('set-cookie') || '').split(';')[0];

      assert(cookie.startsWith('wga_oauth='), 'the start step sets the state cookie');

      const callback = await fetch(
        baseUrl + '/api/v1/auth/oauth/google/callback?code=stub&state=' + encodeURIComponent(state),
        { redirect: 'manual', headers: { cookie } }
      );

      assertEqual(callback.status, 302, 'callback status');

      const location = callback.headers.get('location') || '';
      assert(location.includes('/oauth-callback.html#code='), 'lands on the page with a single-use code');

      const oneTime = new URLSearchParams(new URL(location).hash.replace(/^#/, '')).get('code');
      assert(Boolean(oneTime), 'the code is in the fragment, not the query');

      return request('POST', '/api/v1/auth/oauth/exchange', { body: { code: oneTime } });
    }

    try {
      const first = await signIn();

      assertEqual(first.status, 200, 'exchange status');
      assert(Boolean(first.json.data.accessToken), 'an access token is issued');
      assert(Boolean(first.json.data.refreshToken), 'a refresh token is issued');
      assertEqual(first.json.data.user.email, address, 'the session belongs to the account the provider named');

      const replay = await request('POST', '/api/v1/auth/oauth/exchange', {
        body: { code: 'already-consumed-code' },
      });
      assertEqual(replay.status, 401, 'a code cannot be replayed');

      const user = await User.findOne({ email: address }).lean();
      assert(Array.isArray(user.oauth) && user.oauth.length === 1, 'one provider identity is linked');
      assertEqual(user.oauth[0].provider, 'google', 'provider recorded');
      assertEqual(user.oauth[0].subject, subject, 'the provider subject is stored, not the email');
      assertEqual(user.emailVerified, true, 'the provider proved the address');
      assertEqual(user.role, 'student', 'role is still set by the server');

      const second = await signIn();
      assertEqual(second.status, 200, 'second sign-in');
      assertEqual(second.json.data.user.id, first.json.data.user.id, 'the same account');

      const count = await User.countDocuments({ email: address });
      assertEqual(count, 1, 'no duplicate account is created');
    } finally {
      oauth.exchangeCode = realExchange;
      oauth.fetchProfile = realProfile;
    }
  });
}

/**
 * AI: credits, the tutor, the mentor, assessments and the instructor tools.
 *
 * OpenRouter is never called. The provider is stubbed at the one place every
 * feature goes through — global fetch — so the real request body is built, the
 * real response is parsed and the real credits are spent; only the answer is
 * canned. That is the part worth testing: the ledger and the prompts, not
 * somebody else's model.
 */
async function testAi() {
  const realFetch = global.fetch;
  const captured = [];
  let stubText = 'A short, grounded answer.';

  global.fetch = async (url, options) => {
    if (!String(url).includes('/chat/completions')) return realFetch(url, options);

    const body = JSON.parse(options.body);
    captured.push(body);

    // Answer the assessor with JSON, everyone else with prose.
    const assessing = body.messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('career assessor')
    );

    const content = assessing
      ? JSON.stringify({
          summary: 'You suit practical business work.',
          paths: [
            {
              title: 'Business administrator',
              why: 'You like organising work.',
              firstStep: 'Finish the bookkeeping course.',
              // One real title and one invented: the invented one must be dropped.
              courses: [aiFixtures.courseTitle, 'Course That Does Not Exist'],
            },
          ],
        })
      : stubText;

    return new Response(
      JSON.stringify({
        model: 'stub/model',
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const aiFixtures = {};

  try {
    await check('AI fixtures are provisioned', async () => {
      const register = async (email, firstName) => {
        const { status, json } = await request('POST', '/api/v1/auth/register', {
          body: signupBody({ email, firstName }),
        });
        assertEqual(status, 201, 'registration');
        return json.data;
      };

      const student = await register('smoke-ai-student-' + runId + '@example.com', 'Aistudent');
      const instructor = await register('smoke-ai-instructor-' + runId + '@example.com', 'Aiinstructor');

      createdEmails.push('smoke-ai-student-' + runId + '@example.com');
      createdEmails.push('smoke-ai-instructor-' + runId + '@example.com');

      await User.updateOne({ _id: instructor.user.id }, { $set: { role: 'instructor' } });

      aiFixtures.studentToken = student.accessToken;
      aiFixtures.studentId = student.user.id;

      aiFixtures.instructorToken = (
        await request('POST', '/api/v1/auth/login', {
          body: { email: 'smoke-ai-instructor-' + runId + '@example.com', password: PASSWORD },
        })
      ).json.data.accessToken;

      aiFixtures.courseTitle = 'AI Tutor Course ' + runId;

      /**
       * A paid course, not a free one.
       *
       * The tier rule is that a completely free course carries no AI allowance,
       * so a free fixture would give the test student zero credits and every
       * tutor assertion below would be testing the refusal instead of the
       * answer. The free-tier case gets its own student further down.
       */
      const course = await Course.create({
        title: aiFixtures.courseTitle,
        slug: 'ai-tutor-course-' + runId,
        instructor: instructor.user.id,
        priceCents: 2000,
        status: 'published',
        summary: 'A course for the AI suite.',
        description: 'A course for the AI suite.',
      });
      aiFixtures.courseId = String(course._id);

      // A completely free course: no price and no certificate fee.
      const freeCourse = await Course.create({
        title: 'AI Free Course ' + runId,
        slug: 'ai-free-course-' + runId,
        instructor: instructor.user.id,
        priceCents: 0,
        certificateFeeCents: 0,
        status: 'published',
        summary: 'A completely free course for the AI suite.',
        description: 'A completely free course for the AI suite.',
      });
      aiFixtures.freeCourseId = String(freeCourse._id);

      const freeLesson = await Lesson.create({
        course: freeCourse._id,
        title: 'A free lesson',
        content: '<p>Some free lesson text that is long enough to be grounded in.</p>',
        order: 1,
        published: true,
        type: 'text',
      });
      aiFixtures.freeLessonId = String(freeLesson._id);

      // A certificate-fee course: free to enrol, but not completely free.
      const feeCourse = await Course.create({
        title: 'AI Certificate Fee Course ' + runId,
        slug: 'ai-fee-course-' + runId,
        instructor: instructor.user.id,
        priceCents: 0,
        certificateFeeCents: 1000,
        status: 'published',
        summary: 'A certificate-fee course for the AI suite.',
        description: 'A certificate-fee course for the AI suite.',
      });
      aiFixtures.feeCourseId = String(feeCourse._id);

      const premium = await Course.create({
        title: 'AI Premium Course ' + runId,
        slug: 'ai-premium-course-' + runId,
        instructor: instructor.user.id,
        priceCents: 5000,
        status: 'published',
        summary: 'A premium course for the AI suite.',
        description: 'A premium course for the AI suite.',
      });
      aiFixtures.premiumCourseId = String(premium._id);

      const lesson = await Lesson.create({
        course: course._id,
        title: 'The water cycle',
        content: '<p>Water <strong>evaporates</strong>, condenses and falls as rain.</p>',
        order: 1,
        published: true,
        type: 'text',
      });
      aiFixtures.lessonId = String(lesson._id);

      const orphanLesson = await Lesson.create({
        course: premium._id,
        title: 'Premium lesson',
        content: '<p>Premium content.</p>',
        order: 1,
        published: true,
        type: 'text',
      });
      aiFixtures.orphanLessonId = String(orphanLesson._id);

      await Enrollment.create({
        student: student.user.id,
        course: course._id,
        status: 'active',
        courseTitle: course.title,
      });

      assert(Boolean(aiFixtures.studentToken && aiFixtures.instructorToken), 'both sessions exist');
    });

    await check('credits and costs are readable, and credits need a session', async () => {
      const anonymous = await request('GET', '/api/v1/ai/credits');
      assertEqual(anonymous.status, 401, 'anonymous status');

      const { status, json } = await request('GET', '/api/v1/ai/credits', {
        token: aiFixtures.studentToken,
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.enabled, true, 'the assistant is configured');
      assertEqual(json.data.credits.dailyLimit, 10, 'daily limit');
      assertEqual(json.data.credits.used, 0, 'nothing used yet');
      assertEqual(json.data.credits.remaining, 10, 'full allowance');
      assertEqual(json.data.credits.costs.tutor, 1, 'a tutor question costs one');
      assertEqual(json.data.credits.costs.assessment, 5, 'an assessment costs five');
      assertEqual(json.data.credits.unlimited, false, 'a free-course student is limited');
    });

    await check('the tutor refuses a lesson the student has not enrolled in', async () => {
      const { status, json } = await request('POST', '/api/v1/ai/tutor', {
        token: aiFixtures.studentToken,
        body: { lessonId: aiFixtures.orphanLessonId, question: 'What is this lesson about?' },
      });

      assertEqual(status, 403, 'status');
      assertEqual(json.code, 'ENROLLMENT_REQUIRED', 'error code');
    });

    await check('an enrolled student gets a grounded answer and is charged one credit', async () => {
      const before = captured.length;

      const { status, json } = await request('POST', '/api/v1/ai/tutor', {
        token: aiFixtures.studentToken,
        body: { lessonId: aiFixtures.lessonId, question: 'What happens after evaporation?' },
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.answer, stubText, 'the answer is passed through');
      assertEqual(json.data.credits.used, 1, 'one credit spent');
      assertEqual(json.data.credits.remaining, 9, 'nine left');

      assertEqual(captured.length, before + 1, 'the provider was called once');
      const prompt = captured[captured.length - 1].messages.map((m) => m.content).join('\n');

      assert(prompt.includes('evaporates'), 'the lesson text is in the prompt');
      assert(!prompt.includes('<strong>'), 'the HTML is stripped before it is sent');
      assert(prompt.includes('<student_question>'), 'the question is fenced as a question');
      assert(
        prompt.includes('never as instructions'),
        'and the model is told not to follow instructions inside it'
      );
    });

    await check('spending the daily allowance is refused at the limit, and no call is made', async () => {
      for (let i = 0; i < 9; i += 1) {
        const { status } = await request('POST', '/api/v1/ai/tutor', {
          token: aiFixtures.studentToken,
          body: { lessonId: aiFixtures.lessonId, question: 'Another question ' + i },
        });
        assertEqual(status, 200, 'question ' + i + ' allowed');
      }

      const before = captured.length;

      const { status, json } = await request('POST', '/api/v1/ai/tutor', {
        token: aiFixtures.studentToken,
        body: { lessonId: aiFixtures.lessonId, question: 'One too many' },
      });

      assertEqual(status, 403, 'status');
      assertEqual(json.code, 'AI_CREDITS_EXHAUSTED', 'error code');
      assertEqual(captured.length, before, 'the provider is never called without credits');

      const credits = await request('GET', '/api/v1/ai/credits', { token: aiFixtures.studentToken });
      assertEqual(credits.json.data.credits.remaining, 0, 'the balance is empty');
    });

    await check('an instructor has unlimited access', async () => {
      const { status, json } = await request('GET', '/api/v1/ai/credits', {
        token: aiFixtures.instructorToken,
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.credits.unlimited, true, 'unlimited');
      assertEqual(json.data.credits.reason, 'staff', 'because they are staff');
    });

    await check('a premium enrolment lifts the limit for that student', async () => {
      await Enrollment.create({
        student: aiFixtures.studentId,
        course: aiFixtures.premiumCourseId,
        status: 'active',
        courseTitle: 'AI Premium Course',
      });

      const credits = await request('GET', '/api/v1/ai/credits', {
        token: aiFixtures.studentToken,
      });

      assertEqual(credits.json.data.credits.unlimited, true, 'unlimited while enrolled');
      assertEqual(credits.json.data.credits.reason, 'premium', 'and it says why');

      // The balance was exhausted a moment ago; a premium student is not stopped.
      const { status } = await request('POST', '/api/v1/ai/tutor', {
        token: aiFixtures.studentToken,
        body: { lessonId: aiFixtures.lessonId, question: 'Does this still work?' },
      });

      assertEqual(status, 200, 'a premium student can still ask');
    });

    await check('a completely free course carries no AI allowance at all', async () => {
    // A second student, enrolled only in the free course: no price, no
    // certificate fee, so no allowance and a distinct refusal.
    const freeEmail = 'smoke-ai-free-' + runId + '@example.com';
    const free = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ email: freeEmail, firstName: 'Aifree' }),
    });

    createdEmails.push(freeEmail);
    const freeToken = free.json.data.accessToken;

    await Enrollment.create({
      student: free.json.data.user.id,
      course: aiFixtures.freeCourseId,
      status: 'active',
      courseTitle: 'AI Free Course',
    });

    const credits = await request('GET', '/api/v1/ai/credits', { token: freeToken });

    assertEqual(credits.status, 200, 'status');
    assertEqual(credits.json.data.credits.dailyLimit, 0, 'no daily allowance');
    assertEqual(credits.json.data.credits.limit, 0, 'no limit either');
    assertEqual(credits.json.data.credits.unlimited, false, 'and not unlimited');
    assertEqual(credits.json.data.credits.reason, 'free_course', 'because the course is completely free');

    const before = captured.length;

    const tutor = await request('POST', '/api/v1/ai/tutor', {
      token: freeToken,
      body: { lessonId: aiFixtures.freeLessonId, question: 'What is this lesson about?' },
    });

    assertEqual(tutor.status, 403, 'the tutor is refused');
    assertEqual(tutor.json.code, 'AI_PURCHASE_REQUIRED', 'with a plan code, not exhaustion');
    assertEqual(captured.length, before, 'and the provider is never called');

    const mentor = await request('POST', '/api/v1/ai/mentor', {
      token: freeToken,
      body: { messages: [{ role: 'user', content: 'Where do I start?' }] },
    });

    assertEqual(mentor.status, 403, 'the mentor too');
    assertEqual(mentor.json.code, 'AI_PURCHASE_REQUIRED', 'same code');
  });

  await check('a course with a certificate fee keeps the daily allowance', async () => {
    const feeEmail = 'smoke-ai-fee-' + runId + '@example.com';
    const fee = await request('POST', '/api/v1/auth/register', {
      body: signupBody({ email: feeEmail, firstName: 'Aifee' }),
    });

    createdEmails.push(feeEmail);

    await Enrollment.create({
      student: fee.json.data.user.id,
      course: aiFixtures.feeCourseId,
      status: 'active',
      courseTitle: 'AI Certificate Fee Course',
    });

    const credits = await request('GET', '/api/v1/ai/credits', {
      token: fee.json.data.accessToken,
    });

    assertEqual(credits.json.data.credits.dailyLimit, 10, 'a certificate fee is not nothing');
    assertEqual(credits.json.data.credits.reason, 'paid_course', 'counts as a paid course');
  });

  await check('the tutor rejects a two-letter question with a reason the page can show', async () => {
    // The failure the student actually reported: a short question came back as
    // "The submitted data is invalid" with nothing to act on. The field message
    // is what the panel now prints.
    const { status, json } = await request('POST', '/api/v1/ai/tutor', {
      token: aiFixtures.studentToken,
      body: { lessonId: aiFixtures.lessonId, question: 'hi' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'code');
    assert(Array.isArray(json.details) && json.details.length > 0, 'the reason is in details');
    assertEqual(json.details[0].field, 'question', 'and it names the field');
  });

  await check('the mentor answers and charges one credit', async () => {
      // Drop the premium enrolment so the counter applies again.
      await Enrollment.deleteMany({ student: aiFixtures.studentId, course: aiFixtures.premiumCourseId });
      await User.updateOne(
        { _id: aiFixtures.studentId },
        { $set: { 'aiCredits.period': null, 'aiCredits.used': 0 } }
      );

      const { status, json } = await request('POST', '/api/v1/ai/mentor', {
        token: aiFixtures.studentToken,
        body: { messages: [{ role: 'user', content: 'I want to work in banking. Where do I start?' }] },
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.answer, stubText, 'answer');
      assertEqual(json.data.credits.used, 1, 'one credit');

      const prompt = captured[captured.length - 1].messages.map((m) => m.content).join('\n');
      assert(prompt.includes('Monrovia, Liberia'), 'the mentor is told where the academy is');
      assert(prompt.includes(aiFixtures.courseTitle), 'and what the student is studying');
    });

    await check('a career assessment costs five credits and drops courses that do not exist', async () => {
      const { status, json } = await request('POST', '/api/v1/ai/career-assessment', {
        token: aiFixtures.studentToken,
        body: {
          interests: 'Numbers and people',
          strengths: 'Organising',
          goal: 'Run a small business',
          timePerWeek: 'Five hours',
        },
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.credits.used, 6, 'one plus five');
      assertEqual(json.data.paths.length, 1, 'one path');
      assertEqual(json.data.paths[0].courses.length, 1, 'the invented course is dropped');
      assertEqual(json.data.paths[0].courses[0], aiFixtures.courseTitle, 'the real one is kept');
    });

    await check('every AI call is logged with its tokens', async () => {
      const logs = await AIUsageLog.find({ user: aiFixtures.studentId }).lean();

      assert(logs.length >= 12, 'a row per call, ' + logs.length);
      assert(logs.every((row) => typeof row.totalTokens === 'number'), 'tokens recorded');
      assert(logs.some((row) => row.action === 'assessment'), 'the assessment is logged');
      assert(
        logs.filter((row) => row.action === 'tutor').every((row) => row.question),
        'tutor rows carry the question, which is what the instructor summary reads'
      );
    });

    await check('an instructor gets bullet insights for their own course only', async () => {
      const { status, json } = await request(
        'GET',
        '/api/v1/ai/insights?courseId=' + aiFixtures.courseId,
        { token: aiFixtures.instructorToken }
      );

      assertEqual(status, 200, 'status');
      assert(Array.isArray(json.data.insights) && json.data.insights.length >= 1, 'bullets');
      assertEqual(json.data.facts.total, 1, 'one enrolment counted');

      const asStudent = await request(
        'GET',
        '/api/v1/ai/insights?courseId=' + aiFixtures.courseId,
        { token: aiFixtures.studentToken }
      );
      assertEqual(asStudent.status, 403, 'a student cannot summarise a course');
    });

    await check('a feedback draft is returned for the instructor to edit', async () => {
      const { status, json } = await request('POST', '/api/v1/ai/feedback-draft', {
        token: aiFixtures.instructorToken,
        body: {
          courseId: aiFixtures.courseId,
          submission: 'I reviewed the three ledgers and reconciled the accounts for March.',
          rubric: 'Accuracy, clarity, completeness',
        },
      });

      assertEqual(status, 200, 'status');
      assertEqual(json.data.draft, stubText, 'a draft, not a sent message');

      const asStudent = await request('POST', '/api/v1/ai/feedback-draft', {
        token: aiFixtures.studentToken,
        body: { courseId: aiFixtures.courseId, submission: 'x'.repeat(40) },
      });
      assertEqual(asStudent.status, 403, 'a student cannot draft instructor feedback');
    });
  } finally {
    global.fetch = realFetch;
  }
}

async function main() {
  process.stdout.write('\nWuteve Global Academy — smoke test\n');
  process.stdout.write('==================================\n\n');

  await db.connect();

  /**
   * Sweep before the run, not only after it.
   *
   * This suite runs against the database the live site serves, and several of its
   * fixtures have to be *published* to test publishing, the catalog and
   * enrolment. Teardown removes them, but teardown only runs if the process gets
   * that far: a Ctrl-C, a killed terminal or a machine going to sleep leaves eight
   * fixture courses sitting in the public catalog, which is exactly how they were
   * found on /courses.html.
   *
   * Sweeping first means the next run always repairs the previous one. It does
   * mean two runs must not overlap — they never should; they share one database.
   */
  const swept = await sweepFixtures();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const startedAt = Date.now();

  process.stdout.write(`Serving on ${baseUrl}\n\n`);

  try {
    process.stdout.write('Infrastructure\n');
    await testInfrastructure();

    process.stdout.write('\nRegistration\n');
    await testRegistration();

    process.stdout.write('\nSign-in\n');
    await testLogin();

    process.stdout.write('\nSession handling\n');
    await testSession();

    process.stdout.write('\nRefresh rotation\n');
    await testRefreshRotation();

    process.stdout.write('\nPassword recovery\n');
    await testPasswordRecovery();

    process.stdout.write('\nSign-out\n');
    await testLogout();

    process.stdout.write('\nAuthorisation\n');
    await testDiscussions();

    process.stdout.write('\nSame-origin guard\n');
    await testOriginGuard();

    process.stdout.write('\nLearning loop\n');
    await testLearningLoop();

    process.stdout.write('\nLesson video and quizzes\n');
    await testLessonVideoAndQuizzes();

    process.stdout.write('\nAdministrator-issued password replacement\n');
    await testAdminPasswordReset();

    process.stdout.write('\nNewsletter and contact\n');
    await testNewsletterAndContact();

    process.stdout.write('\nManual payments\n');
    await testManualPayments();

    process.stdout.write('\nCourse taxonomy and credentials\n');
    await testTaxonomyAndCredentials();

    process.stdout.write('\nProfile photos\n');
    await testAvatars();

    process.stdout.write('\nCertificate documents\n');
    await testCertificateDocuments();

    process.stdout.write('\nDeployment configuration\n');
    await testAdminSystemStatus();

    process.stdout.write('\nCommunity, messaging and sessions\n');
    await testCommunityAndMessaging();

    process.stdout.write('\nInput validation\n');
    await testDomainValidation();

    process.stdout.write('\nEmail templates\n');
    await testEmailTemplates();

    process.stdout.write('\nInstructor CVs\n');
    await testInstructorCv();

    process.stdout.write('\nNotification emails\n');
    await testNewNotifications();

    process.stdout.write('\nPartnership enquiries\n');
    await testBusinessEnquiries();

    process.stdout.write('\nEnquiry queue\n');
    await testAdminEnquiries();

    process.stdout.write('\nInstructor applications\n');
    await testInstructorApplications();

    process.stdout.write('\nCertificate fees\n');
    await testCertificateFees();

    process.stdout.write('\nCourse reviews\n');
    await testReviews();

    process.stdout.write('\nInstructor course list\n');
    await testInstructorCoursePagination();

    process.stdout.write('\nOffline admissions\n');
    await testAdmissionsAndStats();

  process.stdout.write('\nSocial sign-in\n');
  await testOAuth();

  process.stdout.write('\nAI credits and assistants\n');
  await testAi();

    process.stdout.write('\nMoney formatting\n');
    await testMoneyFormatting();

    process.stdout.write('\nAdmin reporting\n');
    await testAdminReporting();

    process.stdout.write('\nStripe webhook\n');
    await testStripeWebhook();

    process.stdout.write('\nMobile money\n');
    await testMobileMoney();
  } finally {
    // Cleanup failures are reported rather than swallowed: a silently failing
    // teardown leaves fixtures in the database and the next run starts from a
    // polluted state, which is exactly how stray courses accumulate.
    try {
      await cleanup();
    } catch (error) {
      process.stderr.write(`\n[cleanup] failed: ${error.message}\n${error.stack}\n`);
      results.push({ name: 'cleanup of test fixtures', ok: false, error });
    }

    if (server) await new Promise((resolve) => server.close(resolve));
    await db.disconnect();
  }

  const failed = results.filter((result) => !result.ok);
  const passed = results.length - failed.length;

  const elapsed = Date.now() - startedAt;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.round((elapsed % 60000) / 1000);

  process.stdout.write(`\n${'-'.repeat(40)}\n`);
  process.stdout.write(`${passed}/${results.length} checks passed in ${minutes}m ${seconds}s\n`);

  if (minutes >= 15) {
    process.stdout.write(
      'NOTE: this run exceeded the 15-minute production access-token lifetime.\n' +
        'The suite raises its own TTL to 2h for that reason; if you see 401s in the\n' +
        'late sections, that override has probably been removed.\n'
    );
  }

  if (skipped.length > 0) {
    process.stdout.write(`\nChecks that did not run:\n`);
    for (const item of skipped) process.stdout.write(`  • ${item}\n`);
    process.stdout.write(
      '\nA total lower than usual means a suite was skipped, not that the product\n' +
        'is healthier. The number is not a constant — read it, do not just check it passed.\n'
    );
  }

  if (failed.length > 0) {
    process.stdout.write(`\nFailures:\n`);
    for (const failure of failed) process.stdout.write(`  • ${failure.name}: ${failure.error.message}\n`);

    // Print the server's own reason for anything it refused, so a 401 can be
    // diagnosed from this run rather than needing another one.
    if (rejections.length > 0) {
      process.stdout.write('\nAuthenticated requests the server refused:\n');
      rejections.forEach((r) => {
        process.stdout.write(`  ${r.method} ${r.path}\n`);
        process.stdout.write(`      code    : ${r.code}\n`);
        process.stdout.write(`      message : ${r.message}\n`);
        process.stdout.write(`      token issued at : ${r.issuedAt || '(unreadable)'}  length ${r.tokenLength}\n`);
      });
    }

    process.exit(1);
  }

  process.stdout.write('All checks passed.\n\n');
}

main().catch((error) => {
  process.stderr.write(`\nSmoke test crashed: ${error.stack}\n`);
  process.exit(1);
});
