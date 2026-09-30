#!/usr/bin/env node
'use strict';

/**
 * Verify a deployed instance, from outside it.
 *
 * Run against the real URL after a deploy:
 *
 *   node scripts/verify-deploy.js https://your-app.up.railway.app
 *
 * Why this exists rather than a checklist. The most expensive defect found in
 * this project could not be seen from a terminal: the same-origin guard rejected
 * every browser write in production because browsers send an `Origin` header on
 * POST and `curl` does not, so the API looked fine from this machine while every
 * real sign-in returned 403. A checklist step saying "sign in" depends on someone
 * remembering; this does the same thing with the header attached, and fails
 * loudly.
 *
 * It is read-only apart from two deliberate requests that must be refused, and it
 * never sends a credential. Point it at staging or production safely.
 */

const problems = [];
const checks = [];

function pass(name, detail) {
  checks.push({ ok: true, name, detail });
  process.stdout.write(`  PASS  ${name}${detail ? `  - ${detail}` : ''}\n`);
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
  problems.push(`${name}${detail ? `: ${detail}` : ''}`);
  process.stdout.write(`  FAIL  ${name}${detail ? `  - ${detail}` : ''}\n`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

/* ------------------------------------------------------------------ *
 * Argument
 * ------------------------------------------------------------------ */

const rawBase = process.argv[2];
if (!rawBase) {
  process.stderr.write(
    '\nUsage: node scripts/verify-deploy.js https://your-app.up.railway.app\n\n'
  );
  process.exit(2);
}

const baseUrl = rawBase.replace(/\/+$/, '');
let origin;

try {
  origin = new URL(baseUrl).origin;
} catch {
  process.stderr.write(`\nNot a valid URL: ${rawBase}\n\n`);
  process.exit(2);
}

/**
 * Running against a local address is refused by default, because the check that
 * matters most here — that the process recognises its own origin — behaves
 * differently behind a proxy than it does on loopback, so a pass locally is not
 * evidence of anything. `--allow-local` exists so this script can itself be
 * tested, and so a production-mode server can be verified on this machine before
 * deploying.
 */
const allowLocal = process.argv.includes('--allow-local');

if (!allowLocal && (origin === 'http://localhost:5000' || origin.startsWith('http://127.0.0.1'))) {
  process.stderr.write(
    '\nThat is the local development address. This script is for a deployed instance.\n' +
      'For local checks use `npm test`. To verify a production-mode server running\n' +
      'on this machine, pass --allow-local and read the result with that in mind.\n\n'
  );
  process.exit(2);
}

/**
 * A write that requires authentication and changes nothing.
 *
 * The guard runs before routing, so a cross-origin request to this path is
 * refused by the guard; a same-origin one reaches `authenticate` and is answered
 * 401. That difference is the whole point of the check — and it doubles as a test
 * of `trust proxy`, because if the process does not trust Railway's forwarded
 * protocol, it computes its own origin as http:// while the browser sends
 * https://, and this returns 403 for a request that should never be blocked.
 */
const WRITE_PATH = '/api/v1/payments/checkout/000000000000000000000000';

async function call(method, path, { origin: originHeader, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (originHeader) headers.Origin = originHeader;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an HTML page, which is expected for page requests */
  }

  return { status: response.status, json, text, headers: response.headers };
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function testHealth() {
  const { status, json } = await call('GET', '/health');

  if (status !== 200) {
    fail('the health endpoint answers 200', `got ${status}`);
    return;
  }

  assertEqual(json.status, 'ok', 'health status');
  pass('the health endpoint answers 200', `mongodb ${json.mongodb}, up ${json.uptimeSeconds}s`);
}

async function testPublicApi() {
  const { status, json } = await call('GET', '/api/v1/courses');

  if (status !== 200) {
    fail('the course catalogue is readable without an account', `got ${status}`);
    return;
  }

  // The response is `{ success, message, data: { items, pagination } }`. Asserting
  // the array is really there matters: a deploy whose catalogue endpoint answers
  // 200 with the wrong shape looks healthy and renders an empty site.
  const items = json && json.data && json.data.items;

  if (!Array.isArray(items)) {
    fail('the course catalogue is readable without an account', 'the response carried no item array');
    return;
  }

  const total = json.data.pagination && json.data.pagination.total;
  pass(
    'the course catalogue is readable without an account',
    `${items.length} item(s)${total !== undefined ? ` of ${total} total` : ''}`
  );
}

async function testSameOriginWrite() {
  // This is the one that matters. If this fails with 403 while the previous
  // checks passed, the deployment cannot accept a single write from a browser.
  const { status, json } = await call('POST', WRITE_PATH, { origin, body: {} });

  if (status === 403) {
    fail(
      'a same-origin write is not blocked',
      `403 ${json && json.code} — the server is not recognising its own origin. ` +
        'Check that `trust proxy` is effective and that X-Forwarded-Proto reaches the process.'
    );
    return;
  }

  assertEqual(status, 401, 'status');
  pass('a same-origin write reaches the API', 'rejected 401 for want of a token, as it should be');
}

async function testCrossOriginWrite() {
  const { status, json } = await call('POST', WRITE_PATH, {
    origin: 'https://not-our-site.example',
    body: {},
  });

  assertEqual(status, 403, 'status');
  assertEqual(json && json.code, 'CROSS_ORIGIN_BLOCKED', 'code');
  pass('a cross-origin write is still refused', '403 CROSS_ORIGIN_BLOCKED');
}

async function testPublicBaseUrl() {
  // `GET /api` reports the configured PUBLIC_BASE_URL. In production it is the
  // link inside every verification and password-reset email and the address
  // Stripe redirects to, and defaulting it to localhost is a quiet, common
  // mistake: the deploy looks fine and the emails contain dead links.
  const { status, json } = await call('GET', '/api');

  if (status !== 200) {
    fail('PUBLIC_BASE_URL points at this deployment', `GET /api returned ${status}`);
    return;
  }

  const docs = (json && json.data && json.data.docs) || '';

  if (!docs) {
    fail('PUBLIC_BASE_URL points at this deployment', 'the API did not report it');
    return;
  }

  if (!docs.startsWith(`${origin}/`)) {
    fail(
      'PUBLIC_BASE_URL points at this deployment',
      `it is "${docs}", which is not on ${origin}. Email links and payment redirects will point elsewhere.`
    );
    return;
  }

  pass('PUBLIC_BASE_URL points at this deployment', docs);
}

async function testPageAndNotFound() {
  const page = await call('GET', '/courses.html');

  if (page.status === 200 && page.text.includes('<html')) {
    pass('a page is served', `/courses.html ${page.status}`);
  } else {
    fail('a page is served', `/courses.html returned ${page.status}`);
  }

  const missing = await call('GET', '/a-page-that-does-not-exist-9f2a');

  // A 200 here means every typo is advertised as a valid page, and the 404
  // document can never be reached.
  if (missing.status !== 404) {
    fail('an unknown page returns 404', `got ${missing.status}`);
    return;
  }

  pass('an unknown page returns 404', 'with a real 404 status');
}

async function testSecurityHeaders() {
  const { headers } = await call('GET', '/api/v1/courses');

  const csp = headers.get('content-security-policy');
  if (csp && csp.includes('default-src') && csp.includes("'self'")) {
    pass('a content security policy is sent', 'default-src present');
  } else {
    fail('a content security policy is sent', csp ? 'present but unexpected' : 'absent');
  }

  if (headers.get('x-powered-by')) {
    fail('the framework is not advertised', 'x-powered-by is present');
  } else {
    pass('the framework is not advertised', 'no x-powered-by');
  }
}

async function testMethodListIsPublicAndClean() {
  const { status, text } = await call('GET', '/api/v1/payments/methods');

  if (status !== 200) {
    fail('the payment method list is public', `got ${status}`);
    return;
  }

  /**
   * The response is deliberately unauthenticated, so it must never carry key
   * material. This is a coarse pattern match on purpose: it is looking for the
   * shapes a real credential would take, not proving their absence.
   */
  const suspicious = /(sk_live_|sk_test_|whsec_|re_[A-Za-z0-9]{20}|api[_-]?key"?\s*:\s*"[^"]{12})/i;
  if (suspicious.test(text)) {
    fail('the payment method list leaks no credentials', 'a credential-shaped string was found');
    return;
  }

  const json = JSON.parse(text);
  const methods = (json.data && json.data.methods) || [];
  const usable = methods.filter((m) => m.enabled).map((m) => m.id);

  pass(
    'the payment method list is public and clean',
    methods.length
      ? `${methods.length} listed, usable: ${usable.length ? usable.join(', ') : 'none yet'}`
      : 'none listed'
  );
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
  process.stdout.write(`\nVerifying ${baseUrl}\n`);
  process.stdout.write('='.repeat(Math.min(60, baseUrl.length + 11)) + '\n\n');

  const groups = [
    ['Availability', testHealth],
    ['Public API', testPublicApi],
    ['Same-origin guard', async () => {
      await testSameOriginWrite();
      await testCrossOriginWrite();
    }],
    ['Configuration', testPublicBaseUrl],
    ['Pages', testPageAndNotFound],
    ['Headers', testSecurityHeaders],
    ['Payments', testMethodListIsPublicAndClean],
  ];

  for (const [label, run] of groups) {
    process.stdout.write(`${label}\n`);
    try {
      await run();
    } catch (error) {
      // A network failure is a real result, not a crash: it usually means the
      // service is not up yet, and saying so plainly is more useful than a stack.
      fail(label.toLowerCase(), error.message);
    }
    process.stdout.write('\n');
  }

  const passed = checks.filter((c) => c.ok).length;

  if (problems.length) {
    process.stderr.write(`${passed}/${checks.length} checks passed.\n\n`);
    for (const problem of problems) process.stderr.write(`  * ${problem}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }

  process.stdout.write(`${passed}/${checks.length} checks passed. The deployment is serving.\n\n`);
})();
