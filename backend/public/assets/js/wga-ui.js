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
    emptyState: emptyState,
    injectBaseStyles: injectBaseStyles
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBaseStyles);
  } else {
    injectBaseStyles();
  }
})(window);
