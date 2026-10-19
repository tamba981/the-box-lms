/**
 * Wuteve Global Academy — shared UI helpers.
 *
 * Formatting, escaping and small interactions that every page needs. Kept in
 * one file so that money cannot be formatted one way on the catalog page and
 * another way on the dashboard.
 */
(function attachWgaUi(global) {
  'use strict';

  var CURRENCY_SYMBOLS = { usd: '$', eur: '€', gbp: '£', lrd: 'L$' };

  /** Escape untrusted text before it goes anywhere near innerHTML. */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  /**
   * Money is always formatted from integer minor units. The server sends both
   * `priceCents` and a ready-made `priceLabel`; this is the fallback for values
   * the client computes itself.
   */
  function formatMoney(cents, currency) {
    var amount = Number(cents);
    if (!isFinite(amount)) return '—';
    if (amount === 0) return 'Free';

    var code = String(currency || 'usd').toLowerCase();
    var symbol = CURRENCY_SYMBOLS[code] || code.toUpperCase() + ' ';

    return symbol + (amount / 100).toFixed(2);
  }

  function formatDate(value, options) {
    if (!value) return '—';
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '—';

    return date.toLocaleDateString('en-GB', options || { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateTime(value) {
    if (!value) return '—';
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '—';

    return date.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /** "in 3 days", "2 hours ago" — for session times and notification lists. */
  function formatRelative(value) {
    if (!value) return '—';
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '—';

    var seconds = Math.round((date.getTime() - Date.now()) / 1000);
    var absolute = Math.abs(seconds);

    if (absolute < 60) return seconds >= 0 ? 'just now' : 'a moment ago';

    var units = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60]
    ];

    for (var index = 0; index < units.length; index += 1) {
      var name = units[index][0];
      var size = units[index][1];

      if (absolute >= size) {
        var count = Math.round(absolute / size);
        var plural = count === 1 ? name : name + 's';
        return seconds >= 0 ? 'in ' + count + ' ' + plural : count + ' ' + plural + ' ago';
      }
    }

    return 'just now';
  }

  function initials(name) {
    var parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();

    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  /* ---------------------------------------------------------------- *
   * Toast
   * ---------------------------------------------------------------- */

  var COLORS = { success: '#10b981', error: '#dc2626', info: '#1a56db', warning: '#d4a547' };

  function toast(message, type) {
    var existing = document.querySelector('.wga-toast');
    if (existing) existing.remove();

    var element = document.createElement('div');
    element.className = 'wga-toast';
    element.setAttribute('role', 'status');
    element.textContent = message;
    element.style.cssText = [
      'position:fixed',
      'bottom:26px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:' + (COLORS[type] || COLORS.info),
      'color:#fff',
      'padding:13px 26px',
      'border-radius:12px',
      'font-size:14.5px',
      'font-weight:600',
      'z-index:3000',
      'max-width:min(90vw,560px)',
      'text-align:center',
      'box-shadow:0 10px 30px rgba(0,0,0,0.18)',
      'font-family:inherit',
      'transition:opacity .25s ease'
    ].join(';');

    document.body.appendChild(element);

    setTimeout(function () {
      element.style.opacity = '0';
      setTimeout(function () {
        element.remove();
      }, 260);
    }, type === 'error' ? 5200 : 3400);

    return element;
  }

  /* ---------------------------------------------------------------- *
   * Forms
   * ---------------------------------------------------------------- */

  /** Disable a submit button and show progress, restoring it on failure. */
  function setBusy(button, busy, label) {
    if (!button) return;

    if (busy) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="wga-spinner" aria-hidden="true"></span> ' + escapeHtml(label || 'Working…');
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  /** Render field-level errors returned by the API next to their inputs. */
  function showFieldErrors(form, details) {
    clearFieldErrors(form);
    if (!details || !details.length) return;

    var first = null;

    details.forEach(function (detail) {
      var input = form.querySelector('[name="' + detail.field + '"]');
      if (!input) return;

      var message = document.createElement('p');
      message.className = 'wga-field-error';
      message.textContent = detail.message;
      message.style.cssText = 'color:#dc2626;font-size:12.5px;margin:6px 0 0;';

      var container = input.closest('.field, .form-group, .input-group') || input.parentElement;
      container.appendChild(message);

      if (!first) first = input;
    });

    if (first) first.focus();
  }

  function clearFieldErrors(form) {
    if (!form) return;
    form.querySelectorAll('.wga-field-error').forEach(function (element) {
      element.remove();
    });
  }

  /** A simple inline status line above a form. */
  function status(element, message, type) {
    if (!element) return;

    if (!message) {
      element.style.display = 'none';
      element.textContent = '';
      return;
    }

    var palette = {
      error: { background: '#fef2f2', border: '#fecaca', color: '#991b1b' },
      success: { background: '#ecfdf5', border: '#a7f3d0', color: '#065f46' },
      info: { background: '#eff6ff', border: '#bfdbfe', color: '#1e40af' }
    };

    var tone = palette[type] || palette.info;

    element.style.display = 'block';
    element.style.background = tone.background;
    element.style.border = '1px solid ' + tone.border;
    element.style.color = tone.color;
    element.style.padding = '12px 16px';
    element.style.borderRadius = '10px';
    element.style.fontSize = '14px';
    element.style.lineHeight = '1.5';
    element.textContent = message;
  }

  /* ---------------------------------------------------------------- *
   * Theme — matches the toggle behaviour of the existing pages
   * ---------------------------------------------------------------- */

  function prefersDark() {
    if (localStorage.getItem('theme') === 'dark') return true;
    if (localStorage.getItem('theme') === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    var dark = prefersDark();
    document.body.classList.toggle('dark-mode', dark);

    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.textContent = dark ? '☀️' : '🌙';
      button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    });

    return dark;
  }

  function initTheme() {
    applyTheme();

    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'light' : 'dark');
        applyTheme();
      });
    });
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /** Read a query-string parameter from the current URL. */
  function param(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /** Empty-state markup, so lists never render as a blank panel. */
  function emptyState(title, description) {
    return (
      '<div class="wga-empty" style="text-align:center;padding:44px 20px;color:inherit;">' +
      '<p style="font-weight:700;margin:0 0 6px;">' +
      escapeHtml(title) +
      '</p>' +
      '<p style="margin:0;opacity:0.7;font-size:14px;">' +
      escapeHtml(description || '') +
      '</p>' +
      '</div>'
    );
  }

  /**
   * A person's picture, or their initials when there is none.
   *
   * Returns markup rather than an element so it drops into the existing
   * template strings. The image is lazy and has an empty `alt` — the name is
   * always written next to it, so announcing it twice would be noise.
   */
  function avatar(user, size) {
    var pixels = Number(size) || 40;
    var person = user || {};
    var name = person.fullName || ((person.firstName || '') + ' ' + (person.lastName || '')).trim();

    var frame =
      'width:' + pixels + 'px;height:' + pixels + 'px;border-radius:50%;' +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'flex:0 0 auto;overflow:hidden;background:var(--gold,#d4a547);' +
      'color:#fff;font-weight:600;font-size:' + Math.max(10, Math.round(pixels * 0.38)) + 'px;' +
      'line-height:1;user-select:none;';

    if (person.avatarUrl) {
      return (
        '<span style="' + frame + '">' +
        '<img src="' + escapeHtml(person.avatarUrl) + '" alt="" loading="lazy" ' +
        'style="width:100%;height:100%;object-fit:cover;display:block;" ' +
        // A dead or blocked image must not leave a broken-image icon inside a
        // circle. Falling back to the initials keeps the row readable.
        'onerror="this.parentNode.textContent=this.parentNode.getAttribute(\'data-initials\')||\'\';" ' +
        'data-initials="' + escapeHtml(initials(name)) + '" />' +
        '</span>'
      );
    }

    return '<span style="' + frame + '" aria-hidden="true">' + escapeHtml(initials(name)) + '</span>';
  }

  /**
   * Ask for a photo and hand back a 256×256 data URL.
   *
   * Resizing in the browser is not an optimisation, it is what makes the
   * feature usable: a phone camera produces 3–5 MB, the server accepts 120 KB,
   * and no student should have to know what a kilobyte is to set a picture.
   * `cover` crops from the centre so faces stay in frame.
   *
   * Resolves null when the visitor cancels.
   */
  function pickAvatar(options) {
    var settings = options || {};
    var size = settings.size || 256;

    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';

      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return resolve(null);

        var reader = new FileReader();

        reader.onerror = function () {
          resolve(null);
        };

        reader.onload = function () {
          var image = new Image();

          image.onerror = function () {
            resolve(null);
          };

          image.onload = function () {
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;

            var context = canvas.getContext('2d');
            var scale = Math.max(size / image.width, size / image.height);
            var width = image.width * scale;
            var height = image.height * scale;

            context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

            // JPEG at 0.85 lands around 8–20 KB for a portrait, comfortably
            // inside the limit with no visible loss at this size.
            resolve(canvas.toDataURL('image/jpeg', 0.85));
          };

          image.src = reader.result;
        };

        reader.readAsDataURL(file);
      };

      input.click();
    });
  }

  /* ---------------------------------------------------------------- *
   * Course card
   *
   * One renderer, used by the homepage preview, the catalog and the audience
   * pages. There used to be two - `landingCourseCard` on the homepage and
   * `courseCard` on /courses.html - which drifted: one showed a rating the other
   * did not, and a change to either only reached half the site.
   *
   * Only fields the course payload actually carries are printed. There is no
   * rating, because nothing has been reviewed yet, and the card says "New"
   * instead of showing an empty row of stars.
   *
   * Both stylesheets know these class names: wga-shell.css for the signed-in
   * catalog and wga-public.css for the marketing pages.
   * ---------------------------------------------------------------- */

  function courseCard(course, options) {
    options = options || {};
    var course_ = course || {};

    var key = course_.slug || course_.id || '';
    var href = options.href || '/course.html?course=' + encodeURIComponent(key);

    var thumb = course_.thumbnail
      ? '<img class="wga-course-thumb" src="' + escapeHtml(course_.thumbnail) + '" alt="" loading="lazy" decoding="async" />'
      : '<div class="wga-course-thumb-fallback" aria-hidden="true">' + escapeHtml(glyphFor(course_.title)) + '</div>';

    var level = course_.level
      ? '<span class="card-locked">' + escapeHtml(course_.level) + '</span>'
      : '';

    var tags =
      '<div class="wga-course-tags">' +
      (course_.category ? '<span class="wga-pill">' + escapeHtml(categoryLabel(course_.category)) + '</span>' : '') +
      (Number(course_.ratingCount) === 0 ? '<span class="wga-pill wga-pill-new">New</span>' : '') +
      '</div>';

    var progress = Number(course_.myProgress);
    var progressMarkup =
      course_.isEnrolled && !isNaN(progress)
        ? '<div class="wga-progress" role="progressbar" aria-label="Your progress" aria-valuenow="' +
          Math.max(0, Math.min(100, progress)) +
          '" aria-valuemin="0" aria-valuemax="100"><span style="width:' +
          Math.max(0, Math.min(100, progress)) +
          '%"></span></div>' +
          '<p class="wga-course-note">You are enrolled - ' +
          Math.max(0, Math.min(100, progress)) +
          '% complete</p>'
        : '';

    var price = course_.isFree
      ? '<span class="wga-course-price is-free">Free</span>'
      : '<span class="wga-course-price">' +
        escapeHtml(course_.priceLabel || formatMoney(course_.priceCents, course_.currency)) +
        '</span>';

    var lessons = Number(course_.lessonCount) || 0;
    var enrolled = Number(course_.enrolledCount) || 0;

    return (
      '<a class="wga-course-card" href="' +
      escapeHtml(href) +
      '">' +
      '<div class="thumb-wrap">' +
      thumb +
      level +
      '</div>' +
      '<div class="wga-course-body">' +
      tags +
      '<h3 class="wga-course-title">' +
      escapeHtml(course_.title || 'Untitled course') +
      '</h3>' +
      '<p class="wga-course-summary">' +
      escapeHtml(course_.summary || '') +
      '</p>' +
      progressMarkup +
      '<div class="wga-course-meta">' +
      '<span>' +
      lessons +
      (lessons === 1 ? ' lesson' : ' lessons') +
      '</span>' +
      (course_.credential ? '<span>' + escapeHtml(credentialLabel(course_.credential)) + '</span>' : '') +
      (enrolled > 0 ? '<span>' + enrolled + ' enrolled</span>' : '<span>Open for enrolment</span>') +
      '</div>' +
      '<div class="wga-course-foot">' +
      price +
      '<span class="wga-course-instructor">' +
      escapeHtml(course_.instructorName ? 'with ' + course_.instructorName : '') +
      '</span>' +
      '</div>' +
      '</div>' +
      '</a>'
    );
  }

  /*
   * Categories are slugs (`business-management`) in the course payload, and a
   * slug printed on a card reads like a variable name. A page that has already
   * fetched /courses/categories hands the labels over with setCategoryLabels;
   * anything else gets the slug tidied up rather than shown raw.
   */
  var categoryLabels = {};

  function setCategoryLabels(categories) {
    (categories || []).forEach(function (category) {
      if (!category) return;
      var key = category.name || category.slug;
      if (key) categoryLabels[key] = category.label || humanise(key);
    });
  }

  function humanise(slug) {
    var words = String(slug || '').split(/[-_]+/).filter(Boolean);
    return words
      .map(function (word) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  function categoryLabel(slug) {
    return categoryLabels[slug] || humanise(slug);
  }

  function credentialLabel(credential) {
    if (credential === 'diploma') return 'Diploma';
    if (credential === 'degree') return 'Degree';
    return 'Certificate';
  }

  /** Two letters from a course title, for the thumbnail a course has not got. */
  function glyphFor(title) {
    var words = String(title || '')
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (!words.length) return 'WGA';
    if (words.length === 1) return words[0].slice(0, 2);
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  /** Inject the spinner keyframes once. */
  function injectBaseStyles() {
    if (document.getElementById('wga-ui-styles')) return;

    var style = document.createElement('style');
    style.id = 'wga-ui-styles';
    style.textContent =
      '@keyframes wga-spin{to{transform:rotate(360deg)}}' +
      '.wga-spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.45);' +
      'border-top-color:#fff;border-radius:50%;animation:wga-spin .7s linear infinite;vertical-align:-2px;}' +
      '.wga-skeleton{background:linear-gradient(90deg,rgba(148,163,184,.14) 25%,rgba(148,163,184,.26) 37%,rgba(148,163,184,.14) 63%);' +
      'background-size:400% 100%;animation:wga-shimmer 1.3s ease-in-out infinite;border-radius:8px;}' +
      '@keyframes wga-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}';

    document.head.appendChild(style);
  }

  global.WGAUI = {
    escapeHtml: escapeHtml,
    formatMoney: formatMoney,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatRelative: formatRelative,
    initials: initials,
    avatar: avatar,
    pickAvatar: pickAvatar,
    toast: toast,
    setBusy: setBusy,
    showFieldErrors: showFieldErrors,
    clearFieldErrors: clearFieldErrors,
    status: status,
    initTheme: initTheme,
    prefersDark: prefersDark,
    qs: qs,
    qsa: qsa,
    param: param,
    courseCard: courseCard,
    setCategoryLabels: setCategoryLabels,
    emptyState: emptyState,
    injectBaseStyles: injectBaseStyles
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBaseStyles);
  } else {
    injectBaseStyles();
  }
})(window);
