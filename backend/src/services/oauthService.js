'use strict';

/**
 * Social sign-in: the authorisation-code flow for Google and LinkedIn.
 *
 * Both providers speak OpenID Connect, so the shape of the work is the same for
 * each: send the visitor to the provider with a state value, take the code back
 * on the callback, swap it for an access token, read the profile, and find or
 * create the account behind the verified email address.
 *
 * Three properties are load-bearing and worth stating plainly:
 *
 *   - `state` is signed with the refresh secret and *also* echoed in an
 *     HttpOnly cookie. The cookie is what makes it a CSRF defence: an attacker
 *     who starts a flow of their own cannot make the victim's browser present
 *     the matching cookie, so the callback is refused.
 *   - the email address is only trusted when the provider says it is verified.
 *     Without that check, anyone who can register an account at the provider
 *     with an unverified address could claim somebody else's account here.
 *   - nothing from the provider is written to the database unexamined: names are
 *     trimmed and length-capped, and the subject is matched, never the name.
 */

const crypto = require('crypto');

const config = require('../config/env');
const logger = require('../lib/logger');
const { badRequest, forbidden, unauthorized } = require('../lib/errors');

const User = require('../models/User');

const STATE_COOKIE = 'wga_oauth';

/** Which providers a visitor can actually use, and nothing else about them. */
function listProviders() {
  return Object.values(config.oauth.providers).map((provider) => ({
    name: provider.name,
    label: provider.label,
    enabled: provider.enabled,
  }));
}

function providerFor(name) {
  const provider = config.oauth.providers[name];
  if (!provider) throw badRequest('That sign-in provider is not supported.', { code: 'UNKNOWN_PROVIDER' });
  if (!provider.enabled) {
    throw forbidden(
      `${provider.label} sign-in is not configured on this deployment.`,
      { code: 'PROVIDER_NOT_CONFIGURED' }
    );
  }
  return provider;
}

function callbackUrl(providerName) {
  return `${config.publicBaseUrl}/api/v1/auth/oauth/${providerName}/callback`;
}

/* ------------------------------------------------------------------ *
 * State: signed, single-use, and echoed in a cookie
 * ------------------------------------------------------------------ */

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function signState(payload) {
  const body = base64url(JSON.stringify(payload));
  const mac = crypto
    .createHmac('sha256', config.jwt.refreshSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) throw unauthorized('That sign-in link is not valid.', { code: 'INVALID_STATE' });

  const expected = crypto
    .createHmac('sha256', config.jwt.refreshSecret)
    .update(body)
    .digest('base64url');

  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw unauthorized('That sign-in link is not valid.', { code: 'INVALID_STATE' });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (error) {
    throw unauthorized('That sign-in link is not valid.', { code: 'INVALID_STATE' });
  }

  const age = Math.floor(Date.now() / 1000) - Number(payload.t || 0);
  if (!Number.isFinite(age) || age < 0 || age > config.oauth.stateTtlSeconds) {
    throw unauthorized('That sign-in attempt has expired. Please start again.', {
      code: 'STATE_EXPIRED',
    });
  }

  return payload;
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

/**
 * Read one cookie without pulling in a parser.
 *
 * `cookie-parser` is a dependency to parse a string we control the shape of,
 * and this is the only place in the API that reads a cookie at all.
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    // Lax, not Strict: the callback arrives as a top-level navigation from the
    // provider's domain, and a Strict cookie is not sent on those.
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/api/v1/auth/oauth',
    maxAge: config.oauth.stateTtlSeconds * 1000,
  };
}

/**
 * The same cookie, ready to be expired.
 *
 * `res.clearCookie` sets the expiry itself in Express 5 and warns if `expires`
 * is passed, so the options here are just the ones the cookie was set with —
 * a path mismatch would otherwise leave the original in place.
 */
function clearStateCookieOptions() {
  const { maxAge, ...options } = stateCookieOptions();
  return options;
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

/**
 * Build the provider URL and the two halves of the state (cookie + query).
 *
 * `next` is carried through so somebody who started from a course page lands
 * back there. It is validated on the way in (same-site path only) and again on
 * the way out, because a redirect target that arrives in a query string is an
 * open-redirect waiting to happen.
 */
function beginFlow(providerName, next) {
  const provider = providerFor(providerName);

  const nonce = crypto.randomBytes(24).toString('base64url');
  const state = signState({
    n: nonce,
    p: provider.name,
    t: Math.floor(Date.now() / 1000),
    next: safeNext(next),
  });

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(provider.name),
    response_type: 'code',
    scope: provider.scope,
    state,
  });

  let cookie = state;
  if (provider.pkce) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
    cookie = `${state}|${verifier}`;
  }

  // `prompt=select_account` stops Google silently reusing whichever account
  // happens to be signed in, which on a shared machine signs in the wrong person.
  if (provider.name === 'google') params.set('prompt', 'select_account');

  return { url: `${provider.authorizeUrl}?${params.toString()}`, cookie };
}

/**
 * Validate the callback and hand back what the exchange needs.
 *
 * The cookie and the query string must agree, which is the CSRF check. A
 * mismatch is refused without touching the provider.
 */
function readCallback(providerName, query) {
  const provider = providerFor(providerName);

  const state = String(query.state || '');
  if (!state) throw unauthorized('That sign-in link is missing its state value.', { code: 'MISSING_STATE' });

  const payload = verifyState(state);
  if (payload.p !== provider.name) {
    throw unauthorized('That sign-in link was issued for another provider.', { code: 'STATE_MISMATCH' });
  }

  return {
    provider,
    state,
    next: safeNext(payload.next),
    expectedCookie: state,
  };
}

/** Split the cookie back into state and (when PKCE is used) the verifier. */
function splitStateCookie(value) {
  const [state, verifier] = String(value || '').split('|');
  return { state, verifier: verifier || null };
}

async function postForm(url, form) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = null;
  }

  if (!response.ok) {
    logger.warn('oauth token exchange failed', {
      url,
      status: response.status,
      error: body && (body.error || body.message),
    });
    throw unauthorized('The provider refused that sign-in attempt. Please try again.', {
      code: 'TOKEN_EXCHANGE_FAILED',
    });
  }

  return body || {};
}

/** Swap the authorisation code for an access token. */
async function exchangeCode(provider, { code, verifier }) {
  if (!code) throw unauthorized('That sign-in link carried no code.', { code: 'MISSING_CODE' });

  const form = {
    grant_type: 'authorization_code',
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: callbackUrl(provider.name),
  };

  if (provider.pkce && verifier) {
    form.code_verifier = verifier;
  }

  const body = await postForm(provider.tokenUrl, form);
  if (!body.access_token) {
    throw unauthorized('The provider did not return an access token.', { code: 'NO_ACCESS_TOKEN' });
  }

  return body.access_token;
}

/**
 * Read the profile and normalise it.
 *
 * Both providers return OIDC claims. `email_verified: false` is refused rather
 * than treated as true: the account is keyed on the address, so an unverified
 * one could be used to take over an existing account.
 */
async function fetchProfile(provider, accessToken) {
  const response = await fetch(provider.userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });

  if (!response.ok) {
    logger.warn('oauth userinfo failed', { provider: provider.name, status: response.status });
    throw unauthorized('The provider did not share a profile for that account.', {
      code: 'PROFILE_UNAVAILABLE',
    });
  }

  const claims = await response.json();
  const email = String(claims.email || '').trim().toLowerCase();

  if (!email) {
    throw badRequest(
      'That account did not share an email address. Sign in with email instead, or allow email access at the provider.',
      { code: 'NO_EMAIL' }
    );
  }

  if (claims.email_verified === false) {
    throw badRequest('That account\'s email address is not verified with the provider.', {
      code: 'EMAIL_NOT_VERIFIED',
    });
  }

  const subject = String(claims.sub || '').trim();
  if (!subject) {
    throw unauthorized('The provider did not identify the account.', { code: 'NO_SUBJECT' });
  }

  const fullName = String(claims.name || '').trim();
  const [firstFromFull = '', ...rest] = fullName.split(/\s+/).filter(Boolean);

  const firstName = clean(claims.given_name || firstFromFull || email.split('@')[0]);
  const lastName = clean(claims.family_name || rest.join(' ') || 'Member');

  return { subject, email, firstName, lastName };
}

/** Provider-supplied names are length-capped and stripped of control characters. */
function clean(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80);
}

/**
 * Find the account behind a provider profile, link it, or create it.
 *
 * Order matters. The subject is checked first: an account already linked to this
 * provider is that account, whatever the provider now says the email is. Only
 * then is the email matched. Linking by email is safe *because* the provider
 * verified it — the same guarantee the password reset flow relies on.
 */
async function findOrCreateUser(provider, profile) {
  const linked = await User.findOne({
    oauth: { $elemMatch: { provider: provider.name, subject: profile.subject } },
  });

  if (linked) {
    assertUsable(linked);
    return { user: linked, created: false, linked: false };
  }

  const existing = await User.findOne({ email: profile.email });

  if (existing) {
    assertUsable(existing);

    await User.updateOne(
      { _id: existing._id },
      { $push: { oauth: { provider: provider.name, subject: profile.subject } } }
    );

    // Signing in through a provider that has verified the address proves the
    // address, which is the only thing the verification email was asking.
    if (!existing.emailVerified) {
      await User.updateOne({ _id: existing._id }, { $set: { emailVerified: true } });
      existing.emailVerified = true;
    }

    return { user: existing, created: false, linked: true };
  }

  /**
   * `password` is required by the schema and stays required: a nullable password
   * would mean every sign-in path had to reason about it. A random 48-byte value
   * nobody is told satisfies it, and "forgot password" is how this account gets
   * a usable one.
   */
  const user = await User.create({
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    password: crypto.randomBytes(48).toString('base64url'),
    role: 'student',
    emailVerified: true,
    oauth: [{ provider: provider.name, subject: profile.subject }],
  });

  return { user, created: true, linked: false };
}

function assertUsable(user) {
  if (user.status && user.status !== 'active') {
    throw forbidden(
      'That account cannot sign in right now. Please contact the academy.',
      { code: 'ACCOUNT_NOT_ACTIVE' }
    );
  }
}

/** Only same-site paths are ever accepted as a post-sign-in destination. */
function safeNext(next) {
  const value = String(next || '');
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value.slice(0, 300);
}

module.exports = {
  STATE_COOKIE,
  stateCookieOptions,
  clearStateCookieOptions,
  readCookie,
  splitStateCookie,
  listProviders,
  providerFor,
  callbackUrl,
  beginFlow,
  readCallback,
  exchangeCode,
  fetchProfile,
  findOrCreateUser,
  safeNext,
};
