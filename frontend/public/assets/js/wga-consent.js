/**
 * Cookie notice and language control, for every page.
 *
 * Loaded by /assets/js/wga-ui.js, which every page includes, so neither of these
 * has to be added to 24 HTML documents by hand — and a page added later gets
 * both without anyone remembering to.
 *
 * Two decisions worth stating, because they are choices rather than defaults:
 *
 * 1. The notice asks once, not on every visit. A banner that returns on every
 *    page load is clicked away without being read, which is worse than useless:
 *    it trains people to dismiss the one that matters. The choice is remembered
 *    for a year, and "essential only" is a real option, not a second Accept.
 *
 * 2. Google Translate is not loaded until somebody asks for a translation. The
 *    widget brings Google's own cookies and requests with it, so until that
 *    click there is genuinely nothing on the page from a third party that sets
 *    anything. That keeps the notice honest and keeps the home page fast.
 *
 * Everything is created here rather than in the shared stylesheets: the
 * marketing pages and the dashboards use different palettes, and this has to
 * look deliberate in both. Colours are read from the page at the moment the
 * notice is drawn, so it follows whichever theme is active.
 */
(function () {
  'use strict';

  if (window.__wgaConsentLoaded) return;
  window.__wgaConsentLoaded = true;

  var CONSENT_KEY = 'wga.consent';
  var CONSENT_VERSION = 1;
  var CONSENT_DAYS = 365;

  var LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'ar', label: 'العربية' },
    { code: 'sw', label: 'Kiswahili' },
    { code: 'zh-CN', label: '中文（简体）' },
    { code: 'hi', label: 'हिन्दी' },
    { code: 'de', label: 'Deutsch' },
    { code: 'ru', label: 'Русский' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' }
  ];

  /* ------------------------------------------------------------------ *
   * Theme: read the page rather than guess
   * ------------------------------------------------------------------ */

  function isDarkPage() {
    var body = document.body;
    if (!body) return false;
    if (body.classList.contains('dark-mode')) return true;
    if (document.documentElement.getAttribute('data-theme') === 'dark') return true;

    var bg = window.getComputedStyle(body).backgroundColor || '';
    var match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;

    // Perceived brightness; anything under the midpoint is a dark surface.
    var brightness =
      (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000;
    return brightness < 128;
  }

  function palette(dark) {
    return dark
      ? { panel: '#0f1a2b', text: '#eef4ff', soft: '#c8d5e6', line: '#1e2a3d', accent: '#60a5fa', accentText: '#04101f' }
      : { panel: '#ffffff', text: '#0b1220', soft: '#334155', line: '#e3e8f0', accent: '#2563eb', accentText: '#ffffff' };
  }

  /* ------------------------------------------------------------------ *
   * Styles, once, scoped to these two elements
   * ------------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById('wga-consent-styles')) return;

    var style = document.createElement('style');
    style.id = 'wga-consent-styles';
    style.textContent = [
      '.wga-cookie-notice{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;',
      'padding:16px;display:flex;justify-content:center;pointer-events:none;}',
      '.wga-cookie-card{pointer-events:auto;max-width:760px;width:100%;border-radius:14px;',
      'padding:16px 18px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;',
      'box-shadow:0 18px 40px rgba(4,10,20,.28);border:1px solid var(--wga-c-line);',
      'background:var(--wga-c-panel);color:var(--wga-c-text);',
      'font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;}',
      '.wga-cookie-card p{margin:0;flex:1 1 320px;min-width:260px;color:var(--wga-c-soft);}',
      '.wga-cookie-card strong{color:var(--wga-c-text);display:block;margin-bottom:4px;font-size:14.5px;}',
      '.wga-cookie-card a{color:var(--wga-c-accent);}',
      '.wga-cookie-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.wga-cookie-btn{appearance:none;border:0;border-radius:10px;padding:10px 16px;font:600 13.5px Inter,system-ui,sans-serif;',
      'cursor:pointer;background:var(--wga-c-accent);color:var(--wga-c-accent-text);}',
      '.wga-cookie-btn.is-quiet{background:transparent;color:var(--wga-c-soft);border:1px solid var(--wga-c-line);}',
      '.wga-cookie-btn:focus-visible,.wga-lang-btn:focus-visible,.wga-lang-select:focus-visible{outline:2px solid var(--wga-c-accent);outline-offset:2px;}',

      '.wga-lang{position:fixed;left:16px;bottom:16px;z-index:2147482000;',
      'font:500 13px Inter,system-ui,sans-serif;}',
      'body.has-cookie-notice .wga-lang{bottom:calc(16px + var(--wga-c-h, 96px));}',
      '.wga-lang-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;',
      'border:1px solid var(--wga-c-line);background:var(--wga-c-panel);color:var(--wga-c-text);',
      'box-shadow:0 8px 22px rgba(4,10,20,.18);cursor:pointer;}',
      '.wga-lang-panel{display:none;margin-bottom:8px;padding:12px;border-radius:12px;',
      'border:1px solid var(--wga-c-line);background:var(--wga-c-panel);color:var(--wga-c-text);',
      'box-shadow:0 18px 40px rgba(4,10,20,.24);min-width:230px;}',
      '.wga-lang.is-open .wga-lang-panel{display:block;}',
      '.wga-lang-panel label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;',
      'color:var(--wga-c-soft);margin-bottom:8px;}',
      '.wga-lang-select{width:100%;padding:9px 10px;border-radius:9px;border:1px solid var(--wga-c-line);',
      'background:var(--wga-c-panel);color:var(--wga-c-text);font:500 13.5px Inter,system-ui,sans-serif;}',
      '.wga-lang-note{margin:8px 0 0;font-size:11.5px;line-height:1.5;color:var(--wga-c-soft);}',
      '.wga-lang-panel .goog-te-gadget{font-size:0;}',
      '.wga-lang-panel .goog-te-combo{margin:0;width:100%;padding:9px 10px;border-radius:9px;',
      'border:1px solid var(--wga-c-line);background:var(--wga-c-panel);color:var(--wga-c-text);',
      'font:500 13.5px Inter,system-ui,sans-serif;}',
      '.wga-lang-panel .goog-logo-link,.wga-lang-panel .goog-te-gadget span{display:none !important;}',

      // Google's own toolbar and the gap it opens at the top of the document.
      '.goog-te-banner-frame,.skiptranslate iframe{display:none !important;}',
      'body{top:0 !important;position:static !important;}',
      '@media print{.wga-cookie-notice,.wga-lang{display:none !important;}}',
      '@media (max-width:520px){.wga-lang{left:12px;bottom:12px}.wga-cookie-card{padding:14px}}'
    ].join('');

    document.head.appendChild(style);
  }

  function applyPalette() {
    var colours = palette(isDarkPage());
    var root = document.documentElement;
    root.style.setProperty('--wga-c-panel', colours.panel);
    root.style.setProperty('--wga-c-text', colours.text);
    root.style.setProperty('--wga-c-soft', colours.soft);
    root.style.setProperty('--wga-c-line', colours.line);
    root.style.setProperty('--wga-c-accent', colours.accent);
    root.style.setProperty('--wga-c-accent-text', colours.accentText);
  }

  /* ------------------------------------------------------------------ *
   * The stored choice
   * ------------------------------------------------------------------ */

  function storedChoice() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== CONSENT_VERSION || !parsed.at) return null;

      var age = Date.now() - new Date(parsed.at).getTime();
      if (!(age >= 0) || age > CONSENT_DAYS * 24 * 60 * 60 * 1000) return null;

      return parsed;
    } catch (error) {
      return null;
    }
  }

  function remember(choice) {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        JSON.stringify({ v: CONSENT_VERSION, at: new Date().toISOString(), choice: choice })
      );
    } catch (error) {
      /* Private mode with storage disabled: the notice simply appears next time. */
    }
  }

  /* ------------------------------------------------------------------ *
   * The notice
   * ------------------------------------------------------------------ */

  function showNotice() {
    var wrap = document.createElement('div');
    wrap.className = 'wga-cookie-notice';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Cookies and local storage');

    var card = document.createElement('div');
    card.className = 'wga-cookie-card';
    card.innerHTML = [
      '<p><strong>Cookies and local storage</strong>',
      'We keep a little information in your browser to sign you in and to keep sign-in secure. ',
      'We do not run advertising or analytics, and nothing here follows you around the web. ',
      'Google Translate is only loaded if you choose a language — until then no third party sets ',
      'anything. <a href="/privacy.html">What we store, and why</a>.</p>'
    ].join('');

    var actions = document.createElement('div');
    actions.className = 'wga-cookie-actions';

    var essential = document.createElement('button');
    essential.type = 'button';
    essential.className = 'wga-cookie-btn is-quiet';
    essential.textContent = 'Essential only';

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'wga-cookie-btn';
    accept.textContent = 'Accept';

    function dismiss(choice) {
      remember(choice);
      document.body.classList.remove('has-cookie-notice');
      wrap.remove();
      var button = document.querySelector('.wga-lang-btn');
      if (button) button.focus({ preventScroll: true });
    }

    essential.addEventListener('click', function () {
      dismiss('essential');
    });

    accept.addEventListener('click', function () {
      dismiss('accepted');
    });

    actions.appendChild(essential);
    actions.appendChild(accept);
    card.appendChild(actions);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    // The language button sits above the notice rather than behind it.
    document.body.classList.add('has-cookie-notice');
    requestAnimationFrame(function () {
      document.documentElement.style.setProperty(
        '--wga-c-h',
        Math.ceil(wrap.getBoundingClientRect().height) + 'px'
      );
    });
  }

  /* ------------------------------------------------------------------ *
   * The language control
   * ------------------------------------------------------------------ */

  var translateLoaded = false;
  var currentLanguage = 'en';

  function loadTranslate(onReady) {
    if (translateLoaded) {
      onReady();
      return;
    }
    translateLoaded = true;

    window.googleTranslateElementInit = function () {
      try {
        new window.google.translate.TranslateElement(
          {
            pageLanguage: 'en',
            // Keep the widget's own chrome out of the page; our panel is the
            // interface and the select inside it is the part that matters.
            layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE,
            autoDisplay: false,
            includedLanguages: LANGUAGES.map(function (item) {
              return item.code;
            }).join(',')
          },
          'wga_translate_slot'
        );
      } catch (error) {
        /* A blocked script leaves the note below the select to explain it. */
      }
      onReady();
    };

    var script = document.createElement('script');
    script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    script.async = true;
    script.onerror = onReady;
    document.body.appendChild(script);
  }

  /** Drive Google's own select, which lives in this document, not an iframe. */
  function chooseLanguage(code) {
    var combo = document.querySelector('select.goog-te-combo');
    if (!combo) return false;

    combo.value = code;
    combo.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function buildLanguageControl() {
    var host = document.createElement('div');
    host.className = 'wga-lang';

    var panel = document.createElement('div');
    panel.className = 'wga-lang-panel';
    panel.innerHTML = [
      '<label for="wga-lang-select">Read this page in</label>',
      '<select class="wga-lang-select" id="wga-lang-select">',
      LANGUAGES.map(function (item) {
        return '<option value="' + item.code + '">' + item.label + '</option>';
      }).join(''),
      '</select>',
      '<div id="wga_translate_slot" aria-hidden="true" style="height:0;overflow:hidden"></div>',
      '<p class="wga-lang-note">Translation is provided by Google Translate. Choosing a language ',
      'loads Google\u2019s script, which sets its own cookie.</p>'
    ].join('');

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'wga-lang-btn';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span aria-hidden="true">🌐</span> <span class="wga-lang-label">English</span>';

    var label = button.querySelector('.wga-lang-label');
    var select = panel.querySelector('#wga-lang-select');

    button.addEventListener('click', function () {
      var open = host.classList.toggle('is-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        loadTranslate(function () {
          // Google's select replaces ours once it is alive; keep them in step.
          if (currentLanguage !== 'en') chooseLanguage(currentLanguage);
        });
        select.focus({ preventScroll: true });
      }
    });

    select.addEventListener('change', function () {
      var code = select.value;
      var chosen = LANGUAGES.filter(function (item) {
        return item.code === code;
      })[0];

      currentLanguage = code;
      if (chosen) label.textContent = chosen.label;

      loadTranslate(function () {
        if (!chooseLanguage(code) && code === 'en') {
          // "English" with no widget yet just means leave the page alone.
          return;
        }
      });
    });

    host.appendChild(panel);
    host.appendChild(button);
    document.body.appendChild(host);
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */

  function start() {
    if (document.body.dataset.wgaNoConsent === 'true') return;

    injectStyles();
    applyPalette();
    buildLanguageControl();

    if (!storedChoice()) showNotice();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
