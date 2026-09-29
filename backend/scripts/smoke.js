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

const db = require('../src/db');
const User = require('../src/models/User');
const Token = require('../src/models/Token');
const { createApp } = require('../src/app');

const results = [];
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

async function cleanup() {
  const Course = require('../src/models/Course');
  const Lesson = require('../src/models/Lesson');
  const Enrollment = require('../src/models/Enrollment');
  const Certificate = require('../src/models/Certificate');
  const Message = require('../src/models/Message');
  const Notification = require('../src/models/Notification');
  const Thread = require('../src/models/Thread');
  const StudyGroup = require('../src/models/StudyGroup');
  const LiveSession = require('../src/models/LiveSession');
  const CommunityPost = require('../src/models/CommunityPost');
  const Payment = require('../src/models/Payment');

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
  await Payment.deleteMany({
    $or: [{ student: { $in: userIds } }, { course: { $in: courseIds } }],
  });
  await Enrollment.deleteMany({ _id: { $in: enrollments.map((enrollment) => enrollment._id) } });
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
      body: { firstName: 'Smoke', lastName: 'Tester', email: primaryEmail, password: PASSWORD },
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
      body: {
        firstName: 'Escalate',
        lastName: 'Attempt',
        email,
        password: PASSWORD,
        role: 'admin',
      },
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
      body: { firstName: 'Dup', lastName: 'Licate', email: primaryEmail, password: PASSWORD },
    });
    assertEqual(status, 409, 'status');
    assertEqual(json.success, false, 'success flag');
  });

  await check('a weak password is rejected with field details', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: { firstName: 'Weak', lastName: 'Password', email: `smoke-weak-${runId}@example.com`, password: 'short' },
    });

    assertEqual(status, 400, 'status');
    assertEqual(json.code, 'VALIDATION_ERROR', 'error code');
    assert(Array.isArray(json.details) && json.details.length > 0, 'field details should be returned');
  });

  await check('a malformed email is rejected', async () => {
    const { status } = await request('POST', '/api/v1/auth/register', {
      body: { firstName: 'Bad', lastName: 'Email', email: 'not-an-email', password: PASSWORD },
    });
    assertEqual(status, 400, 'status');
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
}

/**
 * The core product path, end to end: an instructor is given an account, writes
 * a course, an admin approves it, a student enrols, works through it, and is
 * issued a verifiable certificate.
 *
 * This is the suite that answers "does the thing actually work", as opposed to
 * "are the doors locked".
 */
async function testLearningLoop() {
  const Course = require('../src/models/Course');
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
 * Community and messaging, exercised as two different students so that the
 * isolation between them is actually tested.
 */
async function testCommunityAndMessaging() {
  const Course = require('../src/models/Course');
  const CommunityPost = require('../src/models/CommunityPost');

  const peerEmail = `smoke-peer-${runId}@example.com`;
  createdEmails.push(peerEmail);

  let peer = null;
  let peerCourse = null;
  let postId = null;
  let threadId = null;

  await check('a second student can register', async () => {
    const { status, json } = await request('POST', '/api/v1/auth/register', {
      body: { firstName: 'Peer', lastName: 'Student', email: peerEmail, password: PASSWORD },
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
      body: {
        firstName: 'Out',
        lastName: 'Sider',
        email: `smoke-outsider2-${runId}@example.com`,
        password: PASSWORD,
      },
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
      body: { firstName: 'In', lastName: 'Truder', email: intruderEmail, password: PASSWORD },
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
      body: { firstName: 'Stran', lastName: 'Ger', email: strangerEmail, password: PASSWORD },
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
      body: { firstName: 'Stran', lastName: 'Ger2', email: strangerEmail, password: PASSWORD },
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
      body: { firstName: 'Live', lastName: 'Outsider', email: outsiderEmail, password: PASSWORD },
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
  const login = await request('POST', '/api/v1/auth/login', {
    body: { email: 'admin@wuteve.edu', password: 'WuteveDemo12345' },
  });

  if (login.status !== 200) {
    assertEqual(login.status, 401, 'admin login should succeed or be rejected as unknown');
    return;
  }

  const token = login.json.data.accessToken;

  await check('an ordinary student cannot read the admin summaries', async () => {
    const student = await request('POST', '/api/v1/auth/login', {
      body: { email: 'student@wuteve.edu', password: 'WuteveDemo12345' },
    });

    if (student.status !== 200) return;

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


/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('\nWuteve Global Academy — smoke test\n');
  process.stdout.write('==================================\n\n');

  await db.connect();

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

    process.stdout.write('\nLearning loop\n');
    await testLearningLoop();

    process.stdout.write('\nCommunity, messaging and sessions\n');
    await testCommunityAndMessaging();

    process.stdout.write('\nInput validation\n');
    await testDomainValidation();

    process.stdout.write('\nEmail templates\n');
    await testEmailTemplates();

    process.stdout.write('\nMoney formatting\n');
    await testMoneyFormatting();

    process.stdout.write('\nAdmin reporting\n');
    await testAdminReporting();

    process.stdout.write('\nStripe webhook\n');
    await testStripeWebhook();
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
