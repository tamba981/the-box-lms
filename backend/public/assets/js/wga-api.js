/**
 * Wuteve Global Academy — shared API client.
 *
 * This file is the single place the front end talks to the server. Every page
 * includes it, and no page should ever call `fetch` directly.
 *
 * It exists because the previous pages each carried their own copy of an API
 * URL, their own token handling, and their own idea of what to do when a token
 * expired (which was: nothing, so the page silently showed empty data). Here:
 *
 *   · the base URL is same-origin, so nothing breaks when the host changes
 *   · a 401 triggers one automatic token refresh and a single retry
 *   · concurrent 401s share one refresh instead of racing each other
 *   · the session is verified against the server, not assumed from a string
 *     sitting in localStorage
 */
(function attachWgaApi(global) {
  'use strict';

  /** Same origin: the API and these pages are served by the same process. */
  var API_BASE = '/api/v1';

  /**
   * Storage keys are unchanged from the previous implementation, so the pages
   * that have not been migrated yet keep working during the transition.
   */
  var KEYS = {
    access: 'accessToken',
    refresh: 'refreshToken',
    user: 'user'
  };

  var refreshInFlight = null;
  var listeners = [];

  /* ---------------------------------------------------------------- *
   * Session storage
   * ---------------------------------------------------------------- */

  function getAccessToken() {
    return localStorage.getItem(KEYS.access);
  }

  function getRefreshToken() {
    return localStorage.getItem(KEYS.refresh);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(KEYS.user) || 'null');
    } catch (error) {
      return null;
    }
  }

  function setSession(data) {
    if (data.accessToken) localStorage.setItem(KEYS.access, data.accessToken);
    if (data.refreshToken) localStorage.setItem(KEYS.refresh, data.refreshToken);
    if (data.user) localStorage.setItem(KEYS.user, JSON.stringify(data.user));
    emit({ type: 'session', user: getUser() });
  }

  function clearSession() {
    localStorage.removeItem(KEYS.access);
    localStorage.removeItem(KEYS.refresh);
    localStorage.removeItem(KEYS.user);
    emit({ type: 'signed-out' });
  }

  function isSignedIn() {
    return Boolean(getAccessToken());
  }

  /* ---------------------------------------------------------------- *
   * Tiny event bus, so a header badge can react to a session change
   * ---------------------------------------------------------------- */

  function on(handler) {
    listeners.push(handler);
    return function off() {
      listeners = listeners.filter(function (listener) {
        return listener !== handler;
      });
    };
  }

  function emit(event) {
    listeners.forEach(function (listener) {
      try {
        listener(event);
      } catch (error) {
        console.error('[wga] listener failed', error);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Errors
   * ---------------------------------------------------------------- */

  /**
   * An error carrying the server's structured response, so callers can branch
   * on `error.code` (VALIDATION_ERROR, ENROLLMENT_REQUIRED, PAYMENT_REQUIRED…)
   * instead of matching on message text.
   */
  function ApiError(message, options) {
    var error = new Error(message || 'Request failed');
    error.name = 'ApiError';
    error.status = options && options.status;
    error.code = options && options.code;
    error.details = (options && options.details) || null;
    return error;
  }

  /* ---------------------------------------------------------------- *
   * Core request
   * ---------------------------------------------------------------- */

  function buildUrl(path, query) {
    var url = path.indexOf('http') === 0 ? path : API_BASE + path;

    if (query) {
      var parts = [];
      Object.keys(query).forEach(function (key) {
        var value = query[key];
        if (value === undefined || value === null || value === '') return;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
      if (parts.length) url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    }

    return url;
  }

  function rawRequest(method, url, options) {
    var headers = { Accept: 'application/json' };

    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token !== false) {
      var token = getAccessToken();
      if (token) headers.Authorization = 'Bearer ' + token;
    }

    return fetch(url, {
      method: method,
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin'
    }).then(function (response) {
      var contentType = response.headers.get('content-type') || '';

      // A page (the 404 document, for instance) rather than an API response.
      if (contentType.indexOf('application/json') === -1) {
        return response.text().then(function (text) {
          throw ApiError(
            response.status === 404 ? 'Not found' : 'The server returned an unexpected response.',
            { status: response.status, code: 'NOT_JSON', details: text.slice(0, 200) }
          );
        });
      }

      return response.json().catch(function () {
        throw ApiError('The server returned malformed JSON.', { status: response.status, code: 'BAD_JSON' });
      }).then(function (payload) {
        if (response.ok && payload && payload.success !== false) return payload.data;

        throw ApiError(payload && payload.message ? payload.message : 'Request failed', {
          status: response.status,
          code: payload && payload.code,
          details: payload && payload.details
        });
      });
    });
  }

  /**
   * Refresh the session.
   *
   * Single-flight: if five widgets on a page all get a 401 at the same moment,
   * the first triggers the refresh and the other four await the same promise.
   * Without this, five refreshes race and four of them trip the server's
   * replay detection, which would sign the user out.
   */
  function refreshSession() {
    if (refreshInFlight) return refreshInFlight;

    var refreshToken = getRefreshToken();

    if (!refreshToken) {
      return Promise.reject(ApiError('No session to refresh.', { status: 401, code: 'NO_REFRESH_TOKEN' }));
    }

    refreshInFlight = fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken }),
      credentials: 'same-origin'
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok || !payload.success) {
            throw ApiError(payload.message || 'Session expired', { status: response.status, code: payload.code });
          }
          setSession(payload.data);
          return payload.data;
        });
      })
      .finally(function () {
        refreshInFlight = null;
      });

    return refreshInFlight;
  }

  function request(method, path, options) {
    var opts = options || {};
    var url = buildUrl(path, opts.query);

    return rawRequest(method, url, opts).catch(function (error) {
      var isAuthFailure = error.status === 401;

      // Only retry once, and never retry the refresh endpoint against itself.
      if (isAuthFailure && !opts.noRetry && path.indexOf('/auth/refresh') === -1 && path.indexOf('/auth/login') === -1) {
        return refreshSession()
          .then(function () {
            return rawRequest(method, url, opts);
          })
          .catch(function () {
            clearSession();
            var expired = ApiError('Your session has ended. Please sign in again.', {
              status: 401,
              code: 'SESSION_ENDED'
            });
            emit({ type: 'session-expired' });
            throw expired;
          });
      }

      throw error;
    });
  }

  /* ---------------------------------------------------------------- *
   * Public surface
   * ---------------------------------------------------------------- */

  var api = {
    API_BASE: API_BASE,

    get: function (path, options) {
      return request('GET', path, options);
    },
    post: function (path, body, options) {
      return request('POST', path, Object.assign({ body: body }, options || {}));
    },
    patch: function (path, body, options) {
      return request('PATCH', path, Object.assign({ body: body }, options || {}));
    },
    put: function (path, body, options) {
      return request('PUT', path, Object.assign({ body: body }, options || {}));
    },
    del: function (path, options) {
      return request('DELETE', path, options || {});
    },

    /**
     * Send a file straight to object storage at a URL the API signed for it.
     *
     * This deliberately does not go through `request`. That helper prefixes the
     * API base and attaches the session token; both would be wrong here. The URL
     * is absolute and already carries its own signature, and sending our
     * Authorization header to a third-party origin would hand the visitor's
     * session to the storage provider for no reason at all.
     *
     * `contentType` must be exactly what was signed, because it is part of the
     * signature. A mismatch is rejected by the bucket with an error that looks
     * nothing like a content-type problem.
     *
     * options.onProgress  receives a whole-number percentage, 0-100
     * options.onXhr       receives the XMLHttpRequest, so a caller can abort it
     */
    uploadToSignedUrl: function (url, file, options) {
      var settings = options || {};
      var contentType = settings.contentType || file.type;

      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();

        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', contentType);

        if (xhr.upload && typeof settings.onProgress === 'function') {
          xhr.upload.addEventListener('progress', function (event) {
            if (!event.lengthComputable) return;
            settings.onProgress(Math.round((event.loaded / event.total) * 100));
          });
        }

        xhr.addEventListener('load', function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ status: xhr.status });
            return;
          }
          reject(new Error('Storage refused the upload (status ' + xhr.status + ').'));
        });

        xhr.addEventListener('error', function () {
          reject(
            new Error(
              'The upload could not reach storage. Check your connection, then try again.'
            )
          );
        });

        xhr.addEventListener('abort', function () {
          reject(new Error('Upload cancelled.'));
        });

        if (typeof settings.onXhr === 'function') settings.onXhr(xhr);

        xhr.send(file);
      });
    },

    /* ---- session ---- */
    getAccessToken: getAccessToken,
    getRefreshToken: getRefreshToken,
    getUser: getUser,
    setSession: setSession,
    clearSession: clearSession,
    isSignedIn: isSignedIn,
    on: on,

    /**
     * Confirm the stored session against the server.
     * Resolves with `{ user, stats }` or rejects. Never trusts localStorage.
     */
    me: function () {
      return api.get('/auth/me');
    },

    login: function (email, password) {
      return api.post('/auth/login', { email: email, password: password }).then(function (data) {
        setSession(data);
        return data;
      });
    },

    register: function (payload) {
      // `role` is deliberately not sent: the server assigns student, and would
      // strip the field anyway.
      return api.post('/auth/register', payload).then(function (data) {
        setSession(data);
        return data;
      });
    },

    logout: function (allDevices) {
      var refreshToken = getRefreshToken();

      return api
        .post('/auth/logout', { refreshToken: refreshToken, allDevices: Boolean(allDevices) }, { noRetry: true })
        .catch(function () {
          // A failed sign-out must still clear the local session.
          return null;
        })
        .then(function () {
          clearSession();
        });
    },

    /** Send the browser to the sign-in page, remembering where it was. */
    requireSignIn: function (message) {
      var next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/login.html?next=' + next + (message ? '&reason=' + encodeURIComponent(message) : '');
    },

    /**
     * Server-verified role guard.
     *
     * The previous dashboards checked `localStorage.getItem('accessToken')` and
     * nothing else, so typing any string into localStorage opened an admin
     * panel. This asks the server who the caller is and refuses if the role
     * does not match, or if the account is suspended.
     *
     * @param {string[]} allowedRoles
     * @param {{ redirect?: string, onReady?: (session: object) => void }} [options]
     */
    guard: function (allowedRoles, options) {
      var opts = options || {};

      if (!isSignedIn()) {
        api.requireSignIn('signin-required');
        return Promise.reject(ApiError('Not signed in', { status: 401, code: 'NO_TOKEN' }));
      }

      return api
        .me()
        .then(function (session) {
          var role = session && session.user && session.user.role;

          if (allowedRoles && allowedRoles.length && allowedRoles.indexOf(role) === -1) {
            window.location.replace(opts.redirect || api.homeForRole(role));
            return Promise.reject(ApiError('Wrong role', { status: 403, code: 'ROLE_MISMATCH' }));
          }

          setSession({ user: session.user });

          if (typeof opts.onReady === 'function') opts.onReady(session);
          return session;
        })
        .catch(function (error) {
          if (error && error.code === 'SESSION_ENDED') {
            api.requireSignIn('session-expired');
          }
          throw error;
        });
    },

    /** Where each role belongs after signing in. */
    homeForRole: function (role) {
      if (role === 'admin') return '/admin-dashboard.html';
      if (role === 'instructor') return '/instructor-dashboard.html';
      if (role === 'student') return '/student-dashboard.html';
      return '/';
    }
  };

  global.WGA = api;
})(window);
