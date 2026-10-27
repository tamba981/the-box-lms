'use strict';

/**
 * Social sign-in routes.
 *
 * Mounted under `/api/v1/auth`, next to the password routes.
 *
 * The flow is two browser navigations and one API call:
 *
 *   GET  /auth/oauth/:provider/start     → 302 to the provider
 *   GET  /auth/oauth/:provider/callback  → 302 back to the site, carrying a
 *                                          single-use code in the fragment
 *   POST /auth/oauth/exchange            → the code becomes a real session
 *
 * The session itself is never put in a URL. A fragment is not sent to the
 * server or to any proxy, and the code inside it is single-use and short-lived,
 * so a leaked address bar or a shoulder-surfed history entry is worth nothing.
 */

const express = require('express');

const config = require('../config/env');
const User = require('../models/User');
const tokens = require('../services/tokenService');
const oauth = require('../services/oauthService');
const logger = require('../lib/logger');
const { asyncHandler } = require('../lib/asyncHandler');
const { ok } = require('../lib/respond');
const { badRequest } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/oauth');

const router = express.Router();

/** Where a failed attempt sends the visitor, so the page can explain itself. */
function failureRedirect(reason, detail) {
  const params = new URLSearchParams({ oauth: 'error', reason });
  if (detail) params.set('detail', detail);
  return `${config.publicBaseUrl}/login.html?${params.toString()}`;
}

/**
 * Clear the state cookie, then redirect.
 *
 * One helper because both halves have to happen in this order and only once:
 * clearing the cookie after `res.redirect` throws `ERR_HTTP_HEADERS_SENT` and
 * the redirect is lost, which is exactly how the first version of this route
 * failed — the response went out without its `Location` header.
 */
function finish(res, location) {
  res.clearCookie(oauth.STATE_COOKIE, oauth.clearStateCookieOptions());
  return res.redirect(302, location);
}

/**
 * GET /api/v1/auth/oauth/providers
 *
 * The sign-in page asks this before painting the buttons: a provider with no
 * credentials must not look pressable. Public and cheap, so it is fetched on
 * every load rather than a build-time constant that would be wrong after a
 * Railway variable is added.
 */
router.get('/providers', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, { providers: oauth.listProviders() });
});

/**
 * GET /api/v1/auth/oauth/:provider/start
 *
 * A navigation, not a fetch: the visitor has to leave the site. Redirecting
 * rather than throwing means a provider that is switched off still lands the
 * person back on the sign-in page with a sentence they can act on.
 */
router.get(
  '/:provider/start',
  authLimiter,
  asyncHandler(async (req, res) => {
    let flow;
    try {
      flow = oauth.beginFlow(req.params.provider, req.query.next);
    } catch (error) {
      logger.warn('oauth start refused', { provider: req.params.provider, code: error.code });
      return res.redirect(302, failureRedirect(error.code || 'unavailable'));
    }

    res.cookie(oauth.STATE_COOKIE, flow.cookie, oauth.stateCookieOptions());
    return res.redirect(302, flow.url);
  })
);

/**
 * GET /api/v1/auth/oauth/:provider/callback
 *
 * Every failure here is a redirect with a short reason code. The page turns the
 * code into a sentence; the provider's error text is logged, never forwarded,
 * because it can contain the authorisation code or the client id.
 */
router.get(
  '/:provider/callback',
  authLimiter,
  asyncHandler(async (req, res) => {
    const providerName = req.params.provider;

    // Someone who pressed "Cancel" at the provider comes back with this.
    if (req.query.error) {
      logger.warn('oauth provider returned an error', {
        provider: providerName,
        error: String(req.query.error).slice(0, 80),
      });
      return finish(res, failureRedirect('cancelled'));
    }

    let next = '/';
    let created = false;
    let code = null;
    let stage = 'state';

    /**
     * Every step of the callback is inside this try, including issuing the
     * single-use code and building the redirect. An earlier version left the
     * last two outside it, so one mistake there — a helper that was not
     * exported — reached the browser as `INTERNAL_ERROR` with nothing to act
     * on. A stage name is cheap, and it turns the next failure of this kind
     * into a sentence.
     */
    try {
      const callback = oauth.readCallback(providerName, req.query);
      next = callback.next;

      stage = 'cookie';
      const cookie = oauth.splitStateCookie(oauth.readCookie(req, oauth.STATE_COOKIE));
      if (!cookie.state || cookie.state !== callback.state) {
        // The cookie is the CSRF half: without it the callback cannot be shown
        // to belong to a flow this browser started.
        return finish(res, failureRedirect('state_mismatch'));
      }

      stage = 'exchange';
      const accessToken = await oauth.exchangeCode(callback.provider, {
        code: String(req.query.code || ''),
        verifier: cookie.verifier,
      });

      stage = 'profile';
      const profile = await oauth.fetchProfile(callback.provider, accessToken);

      stage = 'account';
      const outcome = await oauth.findOrCreateUser(callback.provider, profile);
      created = outcome.created;

      stage = 'session';
      code = await tokens.createOneTimeToken(outcome.user, 'oauth', 2 * 60 * 1000);
    } catch (error) {
      logger.error('oauth callback failed', {
        provider: providerName,
        stage,
        code: error.code || null,
        message: error.message,
        stack: error.stack,
      });

      return finish(res, failureRedirect(error.code || `${stage}_failed`));
    }

    // A single-use code, not a session: whichever page receives it has to come
    // back to the API to turn it into tokens, and only once.
    const params = new URLSearchParams({ code });
    if (created) params.set('new', '1');
    if (next && next !== '/') params.set('next', next);

    return finish(res, `${config.publicBaseUrl}/oauth-callback.html#${params.toString()}`);
  })
);

/**
 * POST /api/v1/auth/oauth/exchange
 *
 * The code identifies the account; nothing else in the body is read, so a
 * caller cannot choose who they become.
 */
router.post(
  '/exchange',
  authLimiter,
  validate({ body: schemas.exchangeBody }),
  asyncHandler(async (req, res) => {
    const recorded = await tokens.consumeOneTimeToken(req.valid.body.code, 'oauth');

    const user = await User.findById(recorded.user);
    if (!user) throw badRequest('That sign-in is no longer valid. Please try again.', { code: 'UNKNOWN_USER' });
    if (user.status && user.status !== 'active') {
      throw badRequest('That account cannot sign in right now.', { code: 'ACCOUNT_NOT_ACTIVE' });
    }

    const accessToken = tokens.signAccessToken(user);
    const refreshToken = await tokens.issueRefreshToken(user, req);

    return ok(
      res,
      {
        user: user.toPublicJSON({ includePrivate: true }),
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: config.jwt.accessTtl,
      },
      'Signed in.'
    );
  })
);

module.exports = router;
