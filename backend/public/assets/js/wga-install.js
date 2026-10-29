/**
 * "Install the app" — a button that does the right thing on each platform.
 *
 * The two platforms are not equally capable, and pretending otherwise is what
 * makes these buttons useless, so this file treats them separately:
 *
 *   Android / desktop Chrome and Edge
 *     The browser fires `beforeinstallprompt`, and it hands us a function that
 *     opens the real install dialog. One tap, a native sheet, an icon in the app
 *     drawer. This is a genuine one-click install.
 *
 *   iPhone and iPad
 *     There is no install API. Safari has never shipped one, and no amount of
 *     JavaScript can open "Add to Home Screen" — Apple requires the reader to do
 *     it from the Share sheet. A button that claims to install on iOS would have
 *     to lie, so this one opens instructions that name the two taps. It is worse
 *     than Android by Apple's decision, not by ours, and the instructions are the
 *     only honest thing available.
 *
 * Both go through the same button so the site looks the same everywhere.
 */

(function () {
  'use strict';

  var DISMISS_KEY = 'wga.install.dismissed';
  var DISMISS_DAYS = 30;

  var deferredPrompt = null;
  var installedThisSession = false;

  /* ------------------------------------------------------------------ *
   * Platform
   * ------------------------------------------------------------------ */

  var ua = navigator.userAgent || '';

  /**
   * iPadOS 13 and later reports itself as a Mac. The tell is a Mac with a touch
   * screen: no Mac has one, but every iPad does.
   */
  var isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isIphone = /iPhone|iPod/.test(ua);
  var isIos = isIpad || isIphone;

  // Everything on iOS runs WebKit, but only Safari exposes the Add to Home
  // Screen action; Chrome, Firefox and Edge on iOS cannot install at all.
  var isIosSafari = isIos && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  var isAndroid = /Android/.test(ua);

  function isStandalone() {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
    if (navigator.standalone === true) return true;
    // Launched from the Android app drawer, where `display-mode` can be absent.
    return document.referrer.indexOf('android-app://') === 0;
  }

  function dismissedRecently() {
    try {
      var at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      if (!at) return false;
      return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
    } catch (error) {
      return false;
    }
  }

  function rememberDismissal() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (error) {
      /* private mode: the button comes back next visit, which is tolerable */
    }
  }

  /* ------------------------------------------------------------------ *
   * Styles
   *
   * Injected here rather than in wga-shell.css because this file is loaded by
   * both the public pages and the dashboards, and those two load different
   * stylesheets. The values are the site's own palette so it does not look
   * bolted on.
   * ------------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById('wga-install-styles')) return;

    var style = document.createElement('style');
    style.id = 'wga-install-styles';
    style.textContent = [
      '.wga-install{position:fixed;left:16px;bottom:64px;z-index:2147482000;display:none;',
      'align-items:center;gap:8px;font:600 13px Inter,system-ui,-apple-system,"Segoe UI",sans-serif;}',
      '.wga-install.is-visible{display:inline-flex;}',
      // The language control owns the bottom-left corner; move up when the
      // cookie notice is on screen rather than sitting on top of it.
      'body.has-cookie-notice .wga-install{bottom:calc(64px + var(--wga-c-h, 96px));}',
      '.wga-install-btn{display:inline-flex;align-items:center;gap:9px;padding:10px 16px;border-radius:999px;',
      'border:1px solid rgba(15,23,42,.14);cursor:pointer;',
      'background:#0a1628;color:#fff;box-shadow:0 10px 26px rgba(4,14,36,.28);',
      'transition:transform .15s ease,box-shadow .15s ease;}',
      '.wga-install-btn:hover{transform:translateY(-2px);box-shadow:0 14px 30px rgba(4,14,36,.34);}',
      '.wga-install-btn:focus-visible{outline:3px solid #d4a547;outline-offset:3px;}',
      '.wga-install-btn i{color:#d4a547;font-size:14px;}',
      '.wga-install-dismiss{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;',
      'border:1px solid rgba(15,23,42,.14);background:#fff;color:#475569;cursor:pointer;font-size:13px;line-height:1;}',
      '.wga-install-dismiss:hover{background:#f1f5f9;}',

      // The instructions sheet
      '.wga-install-sheet{position:fixed;inset:0;z-index:2147483100;display:none;align-items:flex-end;',
      'justify-content:center;background:rgba(4,10,20,.5);padding:0;}',
      '.wga-install-sheet.is-open{display:flex;}',
      '.wga-install-card{background:#fff;color:#172b4d;width:100%;max-width:460px;border-radius:18px 18px 0 0;',
      'padding:22px 22px 26px;box-shadow:0 -20px 50px rgba(4,14,36,.3);',
      'font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;',
      'animation:wga-install-in .22s ease-out;}',
      '@keyframes wga-install-in{from{transform:translateY(14px);opacity:.5}to{transform:translateY(0);opacity:1}}',
      '@media (prefers-reduced-motion: reduce){.wga-install-card{animation:none}.wga-install-btn{transition:none}}',
      '.wga-install-card h2{margin:0 0 4px;font-size:17px;font-weight:800;letter-spacing:-.01em;}',
      '.wga-install-card .wga-install-lede{margin:0 0 16px;font-size:13.5px;color:#5b6b82;}',
      '.wga-install-step{display:flex;gap:12px;padding:11px 0;border-top:1px solid #e3e8f0;}',
      '.wga-install-step:first-of-type{border-top:0;}',
      '.wga-install-num{flex:none;width:26px;height:26px;border-radius:50%;background:#eff6ff;color:#1d4ed8;',
      'display:grid;place-items:center;font-weight:700;font-size:12.5px;}',
      '.wga-install-step p{margin:0;font-size:13.5px;}',
      '.wga-install-step strong{font-weight:700;}',
      '.wga-install-actions{display:flex;gap:10px;margin-top:18px;}',
      '.wga-install-actions button{flex:1;padding:12px 18px;border-radius:10px;cursor:pointer;',
      'font:600 14px Inter,system-ui,sans-serif;border:1px solid transparent;}',
      '.wga-install-close{background:#0a1628;color:#fff;}',
      '.wga-install-muted{background:transparent;color:#5b6b82;border-color:#e3e8f0;}',
      '@media (min-width:700px){',
      '.wga-install-sheet{align-items:center;}',
      '.wga-install-card{border-radius:18px;}}',
      '@media print{.wga-install,.wga-install-sheet{display:none !important;}}'
    ].join('');

    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ *
   * Instructions sheet (iOS, and any browser with no prompt API)
   * ------------------------------------------------------------------ */

  function shareIcon() {
    // Safari's Share glyph: a box with an arrow leaving the top.
    return (
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
      'style="vertical-align:-3px;display:inline-block;">' +
      '<path d="M12 3v12"/><path d="m8 7 4-4 4 4"/>' +
      '<path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg>'
    );
  }

  function openSheet() {
    injectStyles();

    var existing = document.getElementById('wga-install-sheet');
    if (existing) existing.remove();

    var steps;

    if (isIosSafari) {
      steps = [
        'Tap the <strong>Share</strong> button ' + shareIcon() + ' in Safari\u2019s toolbar \u2014 the square with an arrow coming out of the top.',
        'Scroll the list and choose <strong>Add to Home Screen</strong>.',
        'Tap <strong>Add</strong> in the top-right corner. Wuteve appears on your home screen like any other app.'
      ];
    } else if (isIos) {
      steps = [
        'This browser cannot add apps to the home screen on iPhone or iPad. Open <strong>Safari</strong> and go to <strong>wuteveglobalacademy.com</strong>.',
        'In Safari, tap the <strong>Share</strong> button ' + shareIcon() + '.',
        'Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.'
      ];
    } else if (isAndroid) {
      steps = [
        'Tap the <strong>three dots</strong> in the top-right of your browser.',
        'Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.',
        'Confirm. Wuteve opens full-screen from your app drawer.'
      ];
    } else {
      steps = [
        'Open the <strong>menu</strong> of your browser \u2014 Chrome, Edge and Brave all offer this.',
        'Choose <strong>Install Wuteve</strong>, or <strong>Apps \u2192 Install this site as an app</strong>.',
        'Confirm. It opens in its own window like a desktop application.'
      ];
    }

    var sheet = document.createElement('div');
    sheet.className = 'wga-install-sheet is-open';
    sheet.id = 'wga-install-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'wga-install-title');

    sheet.innerHTML =
      '<div class="wga-install-card">' +
      '<h2 id="wga-install-title">Add Wuteve to your home screen</h2>' +
      '<p class="wga-install-lede">' +
      (isIos
        ? 'Two taps in Safari and it behaves like an installed app \u2014 no browser bar, and your courses one tap away.'
        : 'Your browser does this from its own menu; here is where to look.') +
      '</p>' +
      steps
        .map(function (step, index) {
          return (
            '<div class="wga-install-step">' +
            '<span class="wga-install-num">' + (index + 1) + '</span>' +
            '<p>' + step + '</p>' +
            '</div>'
          );
        })
        .join('') +
      '<div class="wga-install-actions">' +
      '<button type="button" class="wga-install-close" id="wga-install-close">Got it</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(sheet);

    var closeButton = sheet.querySelector('#wga-install-close');

    function close() {
      sheet.remove();
      document.removeEventListener('keydown', onKey);
    }

    function onKey(event) {
      if (event.key === 'Escape') close();
    }

    closeButton.addEventListener('click', close);
    sheet.addEventListener('click', function (event) {
      if (event.target === sheet) close();
    });
    document.addEventListener('keydown', onKey);
    closeButton.focus();
  }

  /* ------------------------------------------------------------------ *
   * The button
   * ------------------------------------------------------------------ */

  function paint() {
    if (isStandalone() || installedThisSession) return;
    if (dismissedRecently()) return;

    // On a platform with no prompt API and no instructions worth giving, stay
    // quiet rather than showing a button that cannot help.
    var canPrompt = Boolean(deferredPrompt);
    var canInstruct = isIos || isAndroid;

    if (!canPrompt && !canInstruct) return;

    injectStyles();

    if (document.getElementById('wga-install')) return;

    var wrap = document.createElement('div');
    wrap.className = 'wga-install is-visible';
    wrap.id = 'wga-install';
    wrap.innerHTML =
      '<button type="button" class="wga-install-btn" id="wga-install-go" ' +
      'aria-label="Install Wuteve Global Academy on this device">' +
      '<i class="fas fa-mobile-screen-button" aria-hidden="true"></i>' +
      '<span>Install app</span>' +
      '</button>' +
      '<button type="button" class="wga-install-dismiss" id="wga-install-no" ' +
      'aria-label="Not now" title="Not now">&times;</button>';

    document.body.appendChild(wrap);

    wrap.querySelector('#wga-install-go').addEventListener('click', onInstallClick);
    wrap.querySelector('#wga-install-no').addEventListener('click', function () {
      rememberDismissal();
      wrap.remove();
    });
  }

  async function onInstallClick() {
    if (!deferredPrompt) {
      openSheet();
      return;
    }

    var button = document.getElementById('wga-install-go');

    try {
      deferredPrompt.prompt();
      var choice = await deferredPrompt.userChoice;

      // The prompt is single-use whichever way it goes.
      deferredPrompt = null;

      if (choice && choice.outcome === 'accepted') {
        installedThisSession = true;
        var wrap = document.getElementById('wga-install');
        if (wrap) wrap.remove();
        if (window.WGAUI && window.WGAUI.toast) {
          window.WGAUI.toast('Installing\u2026 look for Wuteve on your home screen.', 'success');
        }
      } else if (button) {
        // Declining the native sheet is a decision; do not ask again this visit.
        var holder = document.getElementById('wga-install');
        if (holder) holder.remove();
      }
    } catch (error) {
      // Some browsers throw if the prompt is used outside a trusted gesture.
      openSheet();
    }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  window.addEventListener('beforeinstallprompt', function (event) {
    // Without preventDefault Chrome shows its own mini-infobar. Suppressing it
    // is what lets the site place the invitation where it belongs.
    event.preventDefault();
    deferredPrompt = event;
    paint();
  });

  window.addEventListener('appinstalled', function () {
    installedThisSession = true;
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch (error) {
      /* nothing to clean up */
    }
    var wrap = document.getElementById('wga-install');
    if (wrap) wrap.remove();
  });

  // Coming back to the tab after installing: the display mode changes.
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && isStandalone()) {
      var wrap = document.getElementById('wga-install');
      if (wrap) wrap.remove();
    }
  });

  function start() {
    // Android and desktop need the event, which arrives after load; the button is
    // painted from the listener. iOS has no event, so paint immediately.
    if (isIos || isAndroid) paint();

    // On a platform that supports installation, `beforeinstallprompt` can be
    // missed if the page loads slowly, so the button is also offered from here
    // when the browser exposes the older API surface.
    if (!isIos && !isAndroid && navigator.getInstalledRelatedApps) paint();

    registerServiceWorker();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return;
    }

    window.addEventListener('load', function () {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(function (registration) {
          // A new worker waiting means a deploy landed while this tab was open.
          registration.addEventListener('updatefound', function () {
            var installing = registration.installing;
            if (!installing) return;
            installing.addEventListener('statechange', function () {
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                installing.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });
        })
        .catch(function () {
          // Registration is a nicety: without it the site works, it just cannot
          // be installed and has no offline page. Never surface this to a reader.
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
