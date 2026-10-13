/**
 * Wuteve Global Academy — page guard for the authenticated dashboards.
 *
 * Include it in <head> with the roles it should admit:
 *
 *   <script src="/assets/js/wga-api.js"></script>
 *   <script src="/assets/js/wga-guard.js" data-roles="student"></script>
 *
 * Why this exists: the dashboards used to decide whether you were allowed in by
 * checking that *some* string existed in `localStorage.accessToken`. Typing any
 * text into that key was enough to open the administrator panel. The role was
 * then read from `localStorage.user`, which the visitor also controls.
 *
 * The document is hidden until the server has confirmed the session, so there
 * is no flash of a dashboard the viewer is not entitled to see. Confirmation is
 * a single `GET /auth/me`, which also refreshes an expired access token.
 */
(function guardPage() {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var roles = (script.getAttribute('data-roles') || '')
    .split(',')
    .map(function (role) {
      return role.trim();
    })
    .filter(Boolean);

  var root = document.documentElement;
  root.style.visibility = 'hidden';

  function reveal() {
    root.style.visibility = '';
  }

  /**
   * A visible explanation rather than an indefinitely blank page.
   *
   * This runs from <head>, so `document.body` may not exist yet — writing to it
   * directly throws. When the document is still parsing we defer until the body
   * is available, and if a navigation is already under way we do nothing at all,
   * because the page being replaced is irrelevant.
   */
  function fail(message) {
    function write() {
      reveal();

      if (!document.body) return;

      document.body.innerHTML =
        '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;' +
        'max-width:520px;margin:14vh auto;padding:34px;border:1px solid #e5e7eb;border-radius:16px;' +
        'text-align:center;line-height:1.6;">' +
        '<h1 style="font-size:20px;margin:0 0 10px;">We could not open this page</h1>' +
        '<p style="color:#6b7280;margin:0 0 22px;font-size:15px;">' +
        message +
        '</p>' +
        '<a href="/login.html" style="display:inline-block;background:#1a56db;color:#fff;' +
        'text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;">Sign in</a>' +
        '</div>';
    }

    if (document.body) {
      write();
      return;
    }

    document.addEventListener('DOMContentLoaded', write, { once: true });
  }

  if (!window.WGA) {
    fail('The page could not load its client script. Please reload.');
    return;
  }

  // If the stored session is obviously absent, do not wait for a round trip.
  // `requireSignIn` navigates immediately, so there is nothing to draw here —
  // rendering an error page would only flicker before the redirect.
  if (!WGA.isSignedIn()) {
    WGA.requireSignIn('signin-required');
    return;
  }

  var settled = false;

  // A hard ceiling: never leave the viewer staring at a hidden page because a
  // request hung.
  var timeout = setTimeout(function () {
    if (settled) return;
    settled = true;
    fail('This is taking longer than expected, and we could not confirm your session. Please try again.');
  }, 15000);

  WGA.guard(roles, {
    onReady: function () {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reveal();
    }
  }).catch(function (error) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);

    // WGA.guard has already redirected for a role mismatch or an ended session.
    if (error && (error.code === 'ROLE_MISMATCH' || error.code === 'SESSION_ENDED')) {
      fail('Redirecting you to the right page…');
      return;
    }

    fail(
      error && error.status === 401
        ? 'Your session has ended. Please sign in again.'
        : 'We could not confirm your account. Please sign in again.'
    );
  });
})();
