/**
 * AI frontend: the tutor panel on a lesson, the mentor on the dashboard, and the
 * two instructor tools.
 *
 * One file rather than four, because all four are the same three things — read
 * the credit balance, send a message, render an answer — and a chat panel
 * written twice drifts. The differences are the endpoint, the empty state and
 * how the panel is opened.
 *
 * Everything here is a client of the API in docs/AI.md. No prompt text, no model
 * name and no key exists in this file: the server decides what an answer is
 * grounded in, and the browser only asks.
 */
(function () {
  'use strict';

  var state = {
    status: null,
    loading: null,
  };

  /* ------------------------------------------------------------------ *
   * Styles
   *
   * Injected rather than added to wga-shell.css or wga-dash.css: those two are
   * loaded by different pages and this panel appears on both. Everything is
   * written against the tokens those files already define, with fallbacks, so it
   * follows whichever palette the page is using — including the dashboards'
   * dark theme — without a second copy of the colours.
   * ------------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById('wga-ai-styles')) return;

    var css = [
      ':root{--wga-ai-primary:var(--primary,#1a56db);--wga-ai-gold:var(--gold,#d4a547);',
      '--wga-ai-surface:var(--surface,#fff);--wga-ai-text:var(--text,#1f2937);',
      '--wga-ai-muted:var(--text-light,#656e7c);--wga-ai-border:var(--border,#e5e7eb);',
      '--wga-ai-success:var(--success,#10b981);--wga-ai-danger:var(--danger,#b42318);}',

      // Floating launcher
      '.wga-ai-launch{position:fixed;right:20px;bottom:20px;z-index:2147481500;display:inline-flex;',
      'align-items:center;gap:9px;padding:13px 20px;border-radius:999px;border:0;cursor:pointer;',
      'font:600 14px/1 Inter,system-ui,sans-serif;color:#fff;background:var(--wga-ai-primary);',
      'box-shadow:0 10px 26px rgba(10,30,70,.32);transition:transform .15s ease,box-shadow .15s ease;}',
      '.wga-ai-launch:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(10,30,70,.38);}',
      '.wga-ai-launch:focus-visible{outline:3px solid var(--wga-ai-gold);outline-offset:3px;}',
      '.wga-ai-launch[hidden]{display:none;}',

      // Panel
      '.wga-ai-panel{position:fixed;right:20px;bottom:20px;z-index:2147481600;width:min(400px,calc(100vw - 40px));',
      'max-height:min(620px,calc(100vh - 40px));display:none;flex-direction:column;border-radius:16px;',
      'background:var(--wga-ai-surface);color:var(--wga-ai-text);border:1px solid var(--wga-ai-border);',
      'box-shadow:0 24px 60px rgba(4,14,36,.34);overflow:hidden;',
      'font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;}',
      '.wga-ai-panel.is-open{display:flex;}',

      '.wga-ai-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;',
      'border-bottom:1px solid var(--wga-ai-border);background:var(--wga-ai-primary);color:#fff;}',
      '.wga-ai-head h3{margin:0;font-size:15px;font-weight:700;line-height:1.3;}',
      '.wga-ai-head p{margin:2px 0 0;font-size:11.5px;opacity:.9;line-height:1.4;}',
      '.wga-ai-head .wga-ai-close{margin-left:auto;background:rgba(255,255,255,.16);border:0;color:#fff;',
      'width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;flex:none;}',
      '.wga-ai-head .wga-ai-close:hover{background:rgba(255,255,255,.3);}',

      '.wga-ai-credit{padding:7px 16px;font-size:12px;font-weight:600;border-bottom:1px solid var(--wga-ai-border);',
      'background:var(--bg-light,rgba(14,99,196,.06));color:var(--wga-ai-muted);display:flex;',
      'align-items:center;gap:6px;flex-wrap:wrap;}',
      '.wga-ai-credit strong{color:var(--wga-ai-text);}',
      '.wga-ai-credit.is-unlimited strong{color:var(--wga-ai-success);}',
      '.wga-ai-credit.is-empty strong{color:var(--wga-ai-danger);}',
      '.wga-ai-credit::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--wga-ai-success);flex:none;}',
      '.wga-ai-credit.is-empty::before{background:var(--wga-ai-danger);}',

      '.wga-ai-log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px;display:flex;',
      'flex-direction:column;gap:10px;min-height:180px;}',
      '.wga-ai-msg{max-width:88%;padding:10px 13px;border-radius:12px;font-size:13.5px;line-height:1.6;',
      'white-space:pre-wrap;word-break:break-word;}',
      '.wga-ai-msg.is-user{align-self:flex-end;background:var(--wga-ai-primary);color:#fff;border-bottom-right-radius:4px;}',
      '.wga-ai-msg.is-ai{align-self:flex-start;background:var(--bg-light,#f2f5fa);color:var(--wga-ai-text);',
      'border:1px solid var(--wga-ai-border);border-bottom-left-radius:4px;}',
      '.wga-ai-msg.is-error{align-self:stretch;max-width:100%;background:rgba(180,35,24,.08);',
      'border:1px solid rgba(180,35,24,.3);color:var(--wga-ai-danger);font-size:13px;}',
      '.wga-ai-msg.is-note{align-self:stretch;max-width:100%;background:transparent;border:1px dashed var(--wga-ai-border);',
      'color:var(--wga-ai-muted);font-size:12.5px;text-align:center;}',
      '.wga-ai-msg a{color:inherit;text-decoration:underline;}',

      '.wga-ai-typing{align-self:flex-start;display:inline-flex;gap:4px;padding:12px 14px;}',
      '.wga-ai-typing i{width:6px;height:6px;border-radius:50%;background:var(--wga-ai-muted);opacity:.5;',
      'animation:wga-ai-blink 1.1s infinite;}',
      '.wga-ai-typing i:nth-child(2){animation-delay:.18s;}.wga-ai-typing i:nth-child(3){animation-delay:.36s;}',
      '@keyframes wga-ai-blink{0%,60%,100%{opacity:.25;transform:translateY(0);}30%{opacity:1;transform:translateY(-2px);}}',
      '@media (prefers-reduced-motion: reduce){.wga-ai-typing i{animation:none;opacity:.6;}}',

      '.wga-ai-form{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--wga-ai-border);',
      'align-items:flex-end;background:var(--wga-ai-surface);}',
      '.wga-ai-input{flex:1;resize:none;min-height:40px;max-height:110px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--wga-ai-border);background:var(--wga-ai-surface);color:var(--wga-ai-text);',
      'font:14px/1.5 Inter,system-ui,sans-serif;}',
      '.wga-ai-input:focus{outline:none;border-color:var(--wga-ai-primary);box-shadow:0 0 0 3px rgba(26,86,219,.14);}',
      '.wga-ai-send{flex:none;width:40px;height:40px;border-radius:10px;border:0;cursor:pointer;',
      'background:var(--wga-ai-primary);color:#fff;font-size:15px;display:grid;place-items:center;}',
      '.wga-ai-send:disabled{opacity:.5;cursor:not-allowed;}',
      '.wga-ai-foot{padding:0 14px 10px;font-size:11px;color:var(--wga-ai-muted);text-align:center;}',

      // Dashboard: mentor + assessment
      '.wga-ai-tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}',
      '.wga-ai-tab{padding:9px 16px;border-radius:999px;border:1px solid var(--wga-ai-border);cursor:pointer;',
      'background:var(--wga-ai-surface);color:var(--wga-ai-muted);font:600 13px Inter,system-ui,sans-serif;}',
      '.wga-ai-tab.is-on{background:var(--wga-ai-primary);color:#fff;border-color:var(--wga-ai-primary);}',
      '.wga-ai-card{border:1px solid var(--wga-ai-border);border-radius:16px;background:var(--wga-ai-surface);',
      'padding:20px;margin-bottom:18px;}',
      '.wga-ai-card h3{margin:0 0 6px;font-size:17px;font-weight:700;color:var(--wga-ai-text);}',
      '.wga-ai-card p.wga-ai-lede{margin:0 0 16px;font-size:13.5px;color:var(--wga-ai-muted);}',
      '.wga-ai-field{display:block;margin-bottom:12px;}',
      '.wga-ai-field span{display:block;font-size:12px;font-weight:700;letter-spacing:.03em;',
      'text-transform:uppercase;color:var(--wga-ai-muted);margin-bottom:6px;}',
      '.wga-ai-field input,.wga-ai-field textarea{width:100%;padding:11px 13px;border-radius:10px;',
      'border:1px solid var(--wga-ai-border);background:var(--wga-ai-surface);color:var(--wga-ai-text);',
      'font:14px/1.55 Inter,system-ui,sans-serif;}',
      '.wga-ai-field textarea{min-height:80px;resize:vertical;}',
      '.wga-ai-field input:focus,.wga-ai-field textarea:focus{outline:none;border-color:var(--wga-ai-primary);',
      'box-shadow:0 0 0 3px rgba(26,86,219,.14);}',
      '.wga-ai-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;}',
      '.wga-ai-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:10px;',
      'border:0;cursor:pointer;font:600 13.5px Inter,system-ui,sans-serif;background:var(--wga-ai-primary);color:#fff;}',
      '.wga-ai-btn:disabled{opacity:.55;cursor:not-allowed;}',
      '.wga-ai-btn.is-ghost{background:transparent;color:var(--wga-ai-primary);border:1px solid var(--wga-ai-primary);}',
      '.wga-ai-path{border:1px solid var(--wga-ai-border);border-radius:12px;padding:14px 16px;margin-bottom:12px;',
      'background:var(--bg-light,rgba(14,99,196,.04));}',
      '.wga-ai-path h4{margin:0 0 6px;font-size:15px;font-weight:700;color:var(--wga-ai-text);}',
      '.wga-ai-path p{margin:0 0 8px;font-size:13px;color:var(--wga-ai-muted);}',
      '.wga-ai-path ul{margin:0;padding-left:18px;font-size:13px;color:var(--wga-ai-text);}',
      '.wga-ai-path li{margin-bottom:4px;}',
      '.wga-ai-chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:600;',
      'background:rgba(212,165,71,.16);color:var(--wga-ai-gold);margin:2px 4px 2px 0;}',

      // Instructor insights
      '.wga-ai-insights{margin:0;padding:0;list-style:none;}',
      '.wga-ai-insights li{position:relative;padding:8px 0 8px 22px;font-size:13.5px;line-height:1.55;',
      'color:var(--wga-ai-text);border-bottom:1px solid var(--wga-ai-border);}',
      '.wga-ai-insights li:last-child{border-bottom:0;}',
      '.wga-ai-insights li::before{content:"◆";position:absolute;left:0;top:8px;color:var(--wga-ai-gold);font-size:10px;}',
      '.wga-ai-facts{display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;padding-top:14px;',
      'border-top:1px solid var(--wga-ai-border);}',
      '.wga-ai-fact{font-size:12px;color:var(--wga-ai-muted);}',
      '.wga-ai-fact strong{display:block;font-size:18px;color:var(--wga-ai-text);font-weight:800;}',

      // Mobile: the panel is the screen.
      '@media (max-width:600px){',
      '.wga-ai-panel{right:0;bottom:0;left:0;top:0;width:100%;max-height:100%;border-radius:0;border:0;}',
      '.wga-ai-launch{right:14px;bottom:14px;padding:12px 16px;font-size:13px;}',
      '.wga-ai-grid2{grid-template-columns:minmax(0,1fr);}',
      '}',

      '@media print{.wga-ai-panel,.wga-ai-launch{display:none !important;}}'
    ].join('');

    var style = document.createElement('style');
    style.id = 'wga-ai-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ *
   * Credits
   * ------------------------------------------------------------------ */

  /**
   * The balance, cached for the life of the page.
   *
   * Every answer already carries the fresh figures, so the cache is only here to
   * stop a panel opening from costing a request when it was fetched a second ago.
   */
  function status(force) {
    if (state.status && !force) return Promise.resolve(state.status);
    if (state.loading && !force) return state.loading;

    state.loading = WGA.get('/ai/credits')
      .then(function (data) {
        state.status = data;
        return data;
      })
      .catch(function (error) {
        // A failure here must not stop the rest of the page working.
        state.status = { enabled: false, unavailable: true, error: error };
        return state.status;
      })
      .then(function (value) {
        state.loading = null;
        return value;
      });

    return state.loading;
  }

  function setStatus(credits) {
    if (!state.status || !credits) return;
    state.status.credits = credits;
  }

  /**
   * A sentence for a failed request.
   *
   * The API sends the field-level reasons in `details`, and the generic message
   * on its own — "The submitted data is invalid" — tells the reader nothing
   * about what to change. This is what turns a 400 into "Type a question first".
   */
  function describeError(error) {
    if (!error) return 'Something went wrong. Please try again.';

    var base = error.message || 'Something went wrong. Please try again.';

    if (Array.isArray(error.details) && error.details.length) {
      var reasons = error.details
        .map(function (item) {
          return item && item.message ? String(item.message) : null;
        })
        .filter(Boolean);

      if (reasons.length) {
        // The action's own message is usually clearer than the envelope's, and
        // repeating "The submitted data is invalid" above it only adds noise.
        return error.code === 'VALIDATION_ERROR' ? reasons.join(' ') : base + ' ' + reasons.join(' ');
      }
    }

    return base;
  }

  function creditLine(data) {
    if (!data || data.enabled === false) return { text: 'AI is currently unavailable', cls: 'is-empty' };

    var credits = data.credits || {};

    if (credits.unlimited) {
      return {
        text: 'Unlimited AI access' + (credits.reason === 'premium' ? ' — your course includes it' : ''),
        cls: 'is-unlimited',
      };
    }

    // A completely free course carries no allowance at all, which is not the
    // same statement as "you have used them all".
    if (credits.dailyLimit === 0 && !credits.bonus) {
      return { text: 'AI tools are not included with a free course', cls: 'is-empty', plan: true };
    }

    var left = credits.remaining === null ? '—' : credits.remaining;
    return {
      text: left + ' of ' + credits.limit + ' credits left today',
      cls: (credits.remaining || 0) <= 0 ? 'is-empty' : '',
    };
  }

  /* ------------------------------------------------------------------ *
   * The chat panel — used by both the tutor and the mentor
   * ------------------------------------------------------------------ */

  var panel = null;
  var panelConfig = null;

  function buildPanel(config) {
    var host = document.createElement('div');
    host.className = 'wga-ai-panel';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'false');
    host.setAttribute('aria-labelledby', 'wga-ai-title');

    host.innerHTML = [
      '<div class="wga-ai-head">',
      '<div><h3 id="wga-ai-title">' + WGAUI.escapeHtml(config.title) + '</h3>',
      '<p>' + WGAUI.escapeHtml(config.subtitle) + '</p></div>',
      '<button type="button" class="wga-ai-close" aria-label="Close">&times;</button>',
      '</div>',
      '<div class="wga-ai-credit" id="wga-ai-credit">Checking your credits…</div>',
      '<div class="wga-ai-log" id="wga-ai-log" role="log" aria-live="polite"></div>',
      '<form class="wga-ai-form" id="wga-ai-form">',
      '<textarea class="wga-ai-input" id="wga-ai-input" rows="1" maxlength="1200" ',
      'placeholder="' + WGAUI.escapeHtml(config.placeholder) + '" aria-label="Your question"></textarea>',
      '<button type="submit" class="wga-ai-send" id="wga-ai-send" aria-label="Send">',
      '<i class="fas fa-paper-plane" aria-hidden="true"></i></button>',
      '</form>',
      '<div class="wga-ai-foot">' + WGAUI.escapeHtml(config.footnote) + '</div>'
    ].join('');

    document.body.appendChild(host);
    return host;
  }

  function appendMessage(host, role, text) {
    var log = host.querySelector('#wga-ai-log');
    var node = document.createElement('div');
    node.className = 'wga-ai-msg is-' + role;

    if (role === 'ai' || role === 'user') {
      node.textContent = text;
    } else {
      node.innerHTML = text;
    }

    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function showTyping(host) {
    var log = host.querySelector('#wga-ai-log');
    var node = document.createElement('div');
    node.className = 'wga-ai-typing';
    node.innerHTML = '<i></i><i></i><i></i>';
    node.id = 'wga-ai-typing';
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function hideTyping(host) {
    var typing = host.querySelector('#wga-ai-typing');
    if (typing) typing.remove();
  }

  function paintCredits(host, data) {
    var badge = host.querySelector('#wga-ai-credit');
    if (!badge) return;

    var line = creditLine(data);
    badge.className = 'wga-ai-credit ' + line.cls;
    badge.innerHTML = '<strong>' + WGAUI.escapeHtml(line.text) + '</strong>';

    var input = host.querySelector('#wga-ai-input');
    var send = host.querySelector('#wga-ai-send');
    var credits = (data && data.credits) || {};
    var allowed =
      data &&
      data.enabled !== false &&
      (credits.unlimited || (credits.remaining || 0) > 0);

    if (input) input.disabled = !allowed;
    if (send) send.disabled = !allowed;
  }

  /**
   * The message shown when the plan carries no allowance.
   *
   * A completely free course is a different situation from a spent balance: one
   * is about what was bought, the other about today. The wording offers what
   * actually exists — a paid or premium course — rather than a "buy credits"
   * button for a checkout that has not been built.
   */
  function planMessage(host) {
    appendMessage(
      host,
      'error',
      'This course is completely free, and AI tools are not included with it.<br><br>' +
        'Enrolling in a paid course gives you <strong>10 AI questions a day</strong>; a premium course ' +
        'gives you <strong>unlimited</strong> access while you are taking it — ' +
        '<a href="/courses.html">see the catalogue</a>. If you would like to buy credits on their own, ' +
        '<a href="/contact.html">talk to the academy</a>.'
    );
  }

  /**
   * The message shown when the balance is spent.
   *
   * It names the two things that actually help — a premium course, which grants
   * unlimited access, or the academy — rather than offering a "buy credits"
   * button that would go nowhere yet.
   */
  function exhaustedMessage(host, cost) {
    var credits = (state.status && state.status.credits) || {};
    appendMessage(
      host,
      'error',
      'You have used all <strong>' + WGAUI.escapeHtml(credits.limit || 10) +
        ' AI credits</strong> for today. They reset at midnight UTC.<br><br>' +
        'Enrolling in a premium course gives you unlimited AI while you are taking it — ' +
        '<a href="/courses.html">see the catalogue</a>. For anything else, ' +
        '<a href="/contact.html">contact the academy</a>.'
    );
  }

  function unavailableMessage(host) {
    appendMessage(
      host,
      'error',
      'The AI assistant is not available right now. Your instructor is still there for questions — ' +
        'you can reach them from the course page.'
    );
  }

  function openPanel(config) {
    injectStyles();

    if (!panel) {
      panel = buildPanel(config);
      bindPanel(panel, config);
    } else {
      panelConfig = config;
    }

    panelConfig = config;
    panel.classList.add('is-open');

    var input = panel.querySelector('#wga-ai-input');
    if (input && !input.disabled) setTimeout(function () { input.focus(); }, 60);

    status().then(function (data) {
      paintCredits(panel, data);

      if (!data || data.enabled === false) {
        unavailableMessage(panel);
        return;
      }

      if (panel.querySelector('#wga-ai-log').children.length === 0) {
        appendMessage(panel, 'note', config.intro);
      }

      var credits = data.credits || {};

      if (!credits.unlimited && credits.dailyLimit === 0 && !credits.bonus) {
        planMessage(panel);
        return;
      }

      if (!credits.unlimited && (credits.remaining || 0) <= 0) {
        exhaustedMessage(panel, config.cost);
      }
    });

    return panel;
  }

  function bindPanel(host, config) {
    host.querySelector('.wga-ai-close').addEventListener('click', function () {
      host.classList.remove('is-open');
    });

    host.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') host.classList.remove('is-open');
    });

    var form = host.querySelector('#wga-ai-form');
    var input = host.querySelector('#wga-ai-input');

    // Enter sends; Shift+Enter is a newline, because a question can be two lines.
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
      }
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var question = input.value.trim();
      if (!question) return;

      /**
       * The same three-character rule the API enforces, checked here first. Not
       * to replace the server's check — it is the one that counts — but so a
       * two-letter question is answered with "Type a question first" immediately
       * instead of arriving back as "The submitted data is invalid", which is
       * what the reader saw and could do nothing with.
       */
      if (question.length < 3) {
        appendMessage(host, 'error', 'Please write a little more than that — a few words at least.');
        input.focus();
        return;
      }

      var send = host.querySelector('#wga-ai-send');
      var cfg = panelConfig || config;

      input.value = '';
      input.style.height = 'auto';
      input.disabled = true;
      send.disabled = true;

      appendMessage(host, 'user', question);
      showTyping(host);

      cfg
        .send(question)
        .then(function (data) {
          hideTyping(host);
          appendMessage(host, 'ai', data.answer);
          setStatus(data.credits);
          paintCredits(host, state.status);
        })
        .catch(function (error) {
          hideTyping(host);

          if (error && error.code === 'AI_PURCHASE_REQUIRED') {
            planMessage(host);
            status(true).then(function (data) { paintCredits(host, data); });
            return;
          }

          if (error && error.code === 'AI_CREDITS_EXHAUSTED') {
            exhaustedMessage(host, cfg.cost);
            status(true).then(function (data) { paintCredits(host, data); });
            return;
          }

          if (error && (error.code === 'AI_NOT_CONFIGURED' || error.status === 503)) {
            unavailableMessage(host);
            return;
          }

          appendMessage(host, 'error', WGAUI.escapeHtml(describeError(error)));
        })
        .then(function () {
          // Re-read the balance rather than assume it: the run-time answer is
          // what the badge should show, whatever happened.
          input.disabled = false;
          send.disabled = false;
          input.focus();
        });
    });
  }

  /* ------------------------------------------------------------------ *
   * Tutor, on a lesson
   * ------------------------------------------------------------------ */

  function mountTutor(options) {
    injectStyles();
    if (document.querySelector('.wga-ai-launch')) return;

    /**
     * The lesson id is the one thing the API cannot guess, and it is the field a
     * request is most likely to be missing — a syllabus row without an id, or a
     * page that opened a lesson before it had one, produces a 400 that reads as
     * "the submitted data is invalid" with nothing to act on. Refusing to mount
     * is quieter and more honest than offering a button that cannot work.
     */
    if (!options || !/^[a-f\d]{24}$/i.test(String(options.lessonId || ''))) {
      if (window.console && console.warn) {
        console.warn('[wga-ai] no lesson id, so the tutor was not offered:', options);
      }
      return;
    }

    status().then(function (data) {
      if (!data || data.enabled === false) return;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'wga-ai-launch';
      button.innerHTML = '<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Ask about this lesson';
      button.addEventListener('click', function () {
        this.blur();
        openPanel({
          title: 'Ask about this lesson',
          subtitle: options.lessonTitle || 'The tutor answers from this lesson only',
          placeholder: 'What would you like explained?',
          footnote: 'Answers come from this lesson’s text. For anything else, ask your instructor.',
          intro: 'Ask a question about this lesson and the tutor will answer from its text. If the answer is not in the lesson, it will say so.',
          cost: 1,
          send: function (question) {
            return WGA.post('/ai/tutor', { lessonId: options.lessonId, question: question });
          },
        });
      });

      document.body.appendChild(button);
    });
  }

  function unmountTutor() {
    var button = document.querySelector('.wga-ai-launch');
    if (button) button.remove();
    if (panel) panel.classList.remove('is-open');
  }

  /* ------------------------------------------------------------------ *
   * Mentor, on the student dashboard
   * ------------------------------------------------------------------ */

  var mentorHistory = [];

  function mentorPanelHTML() {
    injectStyles();

    return [
      '<div class="wga-ai-card" id="wga-ai-balance-card">',
      '<h3>AI Mentor</h3>',
      '<p class="wga-ai-lede">Career guidance, a learning roadmap, and honest answers about what to do next. ',
      'The mentor knows which courses you are taking.</p>',
      '<div class="wga-ai-credit" id="wga-ai-dash-credit">Checking your credits…</div>',
      '</div>',

      '<div class="wga-ai-tabs" role="tablist">',
      '<button type="button" class="wga-ai-tab is-on" data-ai-tab="chat" role="tab" aria-selected="true">Chat with the mentor</button>',
      '<button type="button" class="wga-ai-tab" data-ai-tab="assessment" role="tab" aria-selected="false">Career path assessment</button>',
      '</div>',

      '<section id="wga-ai-tab-chat">',
      '<div class="wga-ai-card">',
      '<div class="wga-ai-log" id="wga-ai-dash-log" style="max-height:340px;">',
      '<div class="wga-ai-msg is-note">Ask anything about your career direction, or take the assessment above for ',
      'a structured answer with specific courses.</div>',
      '</div>',
      '<form class="wga-ai-form" id="wga-ai-dash-form" style="padding:12px 0 0;border-top:0;">',
      '<textarea class="wga-ai-input" id="wga-ai-dash-input" rows="1" maxlength="2000" ',
      'placeholder="Where do I start if I want to work in finance?" aria-label="Your message"></textarea>',
      '<button type="submit" class="wga-ai-send" id="wga-ai-dash-send" aria-label="Send">',
      '<i class="fas fa-paper-plane" aria-hidden="true"></i></button>',
      '</form>',
      '<p style="margin:10px 0 0;font-size:11.5px;color:var(--wga-ai-muted);">',
      'Each message costs one credit. The mentor will not promise outcomes or invent vacancies.</p>',
      '</div>',
      '</section>',

      '<section id="wga-ai-tab-assessment" hidden>',
      '<div class="wga-ai-card">',
      '<h3>Career path assessment</h3>',
      '<p class="wga-ai-lede">Five short answers. You get two or three career paths and the courses here that ',
      'lead to them. <strong id="wga-ai-assess-cost">This costs 5 credits.</strong></p>',
      '<form id="wga-ai-assess-form">',
      '<div class="wga-ai-grid2">',
      '<label class="wga-ai-field"><span>What interests you</span>',
      '<textarea name="interests" maxlength="600" required placeholder="Numbers, people, fixing things, design…"></textarea></label>',
      '<label class="wga-ai-field"><span>What you are good at</span>',
      '<textarea name="strengths" maxlength="600" required placeholder="Organising, explaining, selling, building…"></textarea></label>',
      '<label class="wga-ai-field"><span>What you are working towards</span>',
      '<textarea name="goal" maxlength="600" required placeholder="A job, a business, a promotion, more confidence…"></textarea></label>',
      '<label class="wga-ai-field"><span>Time you can give each week</span>',
      '<input type="text" name="timePerWeek" maxlength="200" required placeholder="About five hours" /></label>',
      '</div>',
      '<label class="wga-ai-field"><span>Anything else (optional)</span>',
      '<input type="text" name="background" maxlength="600" placeholder="Your work or study so far" /></label>',
      '<button type="submit" class="wga-ai-btn" id="wga-ai-assess-submit">',
      '<i class="fas fa-compass" aria-hidden="true"></i> Get my career paths</button>',
      '</form>',
      '<div id="wga-ai-assess-result" style="margin-top:18px;"></div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function bindMentor(root) {
    var scope = root || document;

    var tabs = scope.querySelectorAll('[data-ai-tab]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (other) {
          other.classList.toggle('is-on', other === tab);
          other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
        });

        var name = tab.getAttribute('data-ai-tab');
        var chat = scope.querySelector('#wga-ai-tab-chat');
        var assessment = scope.querySelector('#wga-ai-tab-assessment');
        if (chat) chat.hidden = name !== 'chat';
        if (assessment) assessment.hidden = name !== 'assessment';
      });
    });

    status().then(function (data) {
      var badge = scope.querySelector('#wga-ai-dash-credit');
      if (!badge) return;

      var line = creditLine(data);
      badge.className = 'wga-ai-credit ' + line.cls;
      badge.innerHTML = '<strong>' + WGAUI.escapeHtml(line.text) + '</strong>';

      if (data && data.credits && data.credits.costs) {
        var cost = scope.querySelector('#wga-ai-assess-cost');
        if (cost) cost.textContent = 'This costs ' + data.credits.costs.assessment + ' credits.';
      }

      if (!data || data.enabled === false) {
        var form = scope.querySelector('#wga-ai-dash-form');
        if (form) form.style.display = 'none';
        var submit = scope.querySelector('#wga-ai-assess-submit');
        if (submit) submit.disabled = true;
        var log = scope.querySelector('#wga-ai-dash-log');
        if (log) {
          log.insertAdjacentHTML(
            'beforeend',
            '<div class="wga-ai-msg is-error">The AI mentor is not available right now. ' +
              'Everything else on your dashboard works as normal.</div>'
          );
        }
        return;
      }

      // No allowance at all: hide the inputs rather than let somebody type a
      // message that the server is going to refuse.
      var credits = data.credits || {};
      if (!credits.unlimited && credits.dailyLimit === 0 && !credits.bonus) {
        var chatForm = scope.querySelector('#wga-ai-dash-form');
        if (chatForm) chatForm.style.display = 'none';
        var assess = scope.querySelector('#wga-ai-assess-form');
        if (assess) assess.style.display = 'none';

        var notice = scope.querySelector('#wga-ai-dash-log');
        if (notice) {
          notice.insertAdjacentHTML(
            'beforeend',
            '<div class="wga-ai-msg is-error">Your courses are completely free, and AI tools are not ' +
              'included with them.<br><br>Enrolling in a paid course gives you <strong>10 AI questions a day</strong>; ' +
              'a premium course gives you <strong>unlimited</strong> access — ' +
              '<a href="/courses.html">see the catalogue</a>. To buy credits on their own, ' +
              '<a href="/contact.html">talk to the academy</a>.</div>'
          );
        }
      }
    });

    var form = scope.querySelector('#wga-ai-dash-form');
    var input = scope.querySelector('#wga-ai-dash-input');
    var log = scope.querySelector('#wga-ai-dash-log');

    function addMessage(role, text) {
      var node = document.createElement('div');
      node.className = 'wga-ai-msg is-' + role;
      if (role === 'ai' || role === 'user') node.textContent = text;
      else node.innerHTML = text;
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    }

    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();

        var text = input.value.trim();
        if (!text) return;

        var send = scope.querySelector('#wga-ai-dash-send');
        input.value = '';
        input.disabled = true;
        send.disabled = true;

        mentorHistory.push({ role: 'user', content: text });
        addMessage('user', text);

        var typing = document.createElement('div');
        typing.className = 'wga-ai-typing';
        typing.innerHTML = '<i></i><i></i><i></i>';
        log.appendChild(typing);
        log.scrollTop = log.scrollHeight;

        WGA.post('/ai/mentor', { messages: mentorHistory })
          .then(function (data) {
            typing.remove();
            addMessage('ai', data.answer);
            mentorHistory.push({ role: 'assistant', content: data.answer });
            setStatus(data.credits);

            var badge = scope.querySelector('#wga-ai-dash-credit');
            var line = creditLine(state.status);
            if (badge) {
              badge.className = 'wga-ai-credit ' + line.cls;
              badge.innerHTML = '<strong>' + WGAUI.escapeHtml(line.text) + '</strong>';
            }
          })
          .catch(function (error) {
            typing.remove();
            if (error && error.code === 'AI_PURCHASE_REQUIRED') {
              addMessage(
                'error',
                'AI tools are not included with a completely free course. Enrolling in a paid course ' +
                  'gives you 10 questions a day, and a premium course gives you unlimited access — ' +
                  '<a href="/courses.html">see the catalogue</a>.'
              );
            } else if (error && error.code === 'AI_CREDITS_EXHAUSTED') {
              addMessage(
                'error',
                'You have used all your AI credits for today. They reset at midnight UTC. ' +
                  'A premium course gives you unlimited AI while you take it — ' +
                  '<a href="/courses.html">see the catalogue</a>.'
              );
              status(true);
            } else if (error && (error.code === 'AI_NOT_CONFIGURED' || error.status === 503)) {
              addMessage('error', 'The AI mentor is not available right now.');
            } else {
              addMessage('error', WGAUI.escapeHtml(describeError(error)));
            }
          })
          .then(function () {
            input.disabled = false;
            send.disabled = false;
            input.focus();
          });
      });
    }

    var assessmentForm = scope.querySelector('#wga-ai-assess-form');
    if (assessmentForm) {
      assessmentForm.addEventListener('submit', function (event) {
        event.preventDefault();

        var submit = scope.querySelector('#wga-ai-assess-submit');
        var result = scope.querySelector('#wga-ai-assess-result');
        var body = {};

        new FormData(assessmentForm).forEach(function (value, key) {
          body[key] = String(value).trim();
        });

        submit.disabled = true;
        submit.innerHTML = '<span class="loading-spinner" style="width:15px;height:15px;"></span> Working…';
        result.innerHTML = '';

        WGA.post('/ai/career-assessment', body)
          .then(function (data) {
            setStatus(data.credits);

            var html = '<div class="wga-ai-card" style="margin:0;">';
            if (data.summary) html += '<p style="margin:0 0 16px;font-size:14px;color:var(--wga-ai-text);">' +
              WGAUI.escapeHtml(data.summary) + '</p>';

            (data.paths || []).forEach(function (path) {
              html += '<div class="wga-ai-path"><h4>' + WGAUI.escapeHtml(path.title) + '</h4>';
              if (path.why) html += '<p>' + WGAUI.escapeHtml(path.why) + '</p>';
              if (path.courses && path.courses.length) {
                html += '<ul>' + path.courses.map(function (title) {
                  return '<li>' + WGAUI.escapeHtml(title) + '</li>';
                }).join('') + '</ul>';
              }
              if (path.firstStep) {
                html += '<p style="margin:10px 0 0;"><span class="wga-ai-chip">First step</span> ' +
                  WGAUI.escapeHtml(path.firstStep) + '</p>';
              }
              html += '</div>';
            });

            html += '<p style="margin:16px 0 0;"><a class="wga-ai-btn is-ghost" href="/courses.html">Browse the courses</a></p>';
            html += '</div>';

            result.innerHTML = html;

            var badge = scope.querySelector('#wga-ai-dash-credit');
            var line = creditLine(state.status);
            if (badge) {
              badge.className = 'wga-ai-credit ' + line.cls;
              badge.innerHTML = '<strong>' + WGAUI.escapeHtml(line.text) + '</strong>';
            }
          })
          .catch(function (error) {
            if (error && error.code === 'AI_PURCHASE_REQUIRED') {
              result.innerHTML = '<div class="wga-ai-msg is-error" style="max-width:100%;">' +
                'AI tools are not included with a completely free course. Enrolling in a paid course ' +
                'unlocks them — <a href="/courses.html">see the catalogue</a>.</div>';
            } else if (error && error.code === 'AI_CREDITS_EXHAUSTED') {
              result.innerHTML = '<div class="wga-ai-msg is-error" style="max-width:100%;">' +
                'You need five credits for an assessment and do not have them today. ' +
                'They reset at midnight UTC, or a premium course gives you unlimited AI.</div>';
              status(true);
            } else if (error && (error.code === 'AI_NOT_CONFIGURED' || error.status === 503)) {
              result.innerHTML = '<div class="wga-ai-msg is-error" style="max-width:100%;">' +
                'The assessment is not available right now.</div>';
            } else {
              result.innerHTML = '<div class="wga-ai-msg is-error" style="max-width:100%;">' +
                WGAUI.escapeHtml(describeError(error)) +
                '</div>';
            }
          })
          .then(function () {
            submit.disabled = false;
            submit.innerHTML = '<i class="fas fa-compass" aria-hidden="true"></i> Get my career paths';
          });
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Instructor: insights and feedback drafts
   * ------------------------------------------------------------------ */

  function insightsHTML(courseId) {
    injectStyles();

    return [
      '<div class="wga-ai-card" data-ai-insights="' + WGAUI.escapeHtml(courseId) + '">',
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">',
      '<div><h3>AI insights</h3>',
      '<p class="wga-ai-lede" style="margin:0;">What students are struggling with, drawn from their progress ',
      'and the questions they asked the tutor.</p></div>',
      '<button type="button" class="wga-ai-btn is-ghost" data-ai-insights-refresh="' + WGAUI.escapeHtml(courseId) + '">',
      '<i class="fas fa-rotate" aria-hidden="true"></i> Refresh</button>',
      '</div>',
      '<div data-ai-insights-body style="margin-top:16px;">',
      '<p style="margin:0;font-size:13px;color:var(--wga-ai-muted);">Press Refresh to summarise this course.</p>',
      '</div>',
      '</div>'
    ].join('');
  }

  function loadInsights(container) {
    var courseId = container.getAttribute('data-ai-insights');
    var body = container.querySelector('[data-ai-insights-body]');
    var button = container.querySelector('[data-ai-insights-refresh]');

    if (button) button.disabled = true;
    body.innerHTML = '<div style="text-align:center;padding:20px;"><div class="loading-spinner"></div></div>';

    return WGA.get('/ai/insights?courseId=' + encodeURIComponent(courseId))
      .then(function (data) {
        var facts = data.facts || {};

        body.innerHTML =
          '<ul class="wga-ai-insights">' +
          (data.insights || [])
            .map(function (line) {
              return '<li>' + WGAUI.escapeHtml(line) + '</li>';
            })
            .join('') +
          '</ul>' +
          '<div class="wga-ai-facts">' +
          '<div class="wga-ai-fact"><strong>' + (facts.total || 0) + '</strong>enrolled</div>' +
          '<div class="wga-ai-fact"><strong>' + (facts.completed || 0) + '</strong>completed</div>' +
          '<div class="wga-ai-fact"><strong>' + (facts.averageProgress || 0) + '%</strong>average progress</div>' +
          (facts.averageScore === null || facts.averageScore === undefined
            ? ''
            : '<div class="wga-ai-fact"><strong>' + facts.averageScore + '%</strong>average quiz score</div>') +
          '</div>';
      })
      .catch(function (error) {
        var message =
          error && error.code === 'AI_NOT_CONFIGURED'
            ? 'AI insights are not available on this deployment yet.'
            : (error && error.message) || 'Could not build the summary. Please try again.';

        body.innerHTML =
          '<p style="margin:0;font-size:13px;color:var(--wga-ai-muted);">' +
          WGAUI.escapeHtml(message) +
          '</p>';
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  function bindInsights(root) {
    (root || document).querySelectorAll('[data-ai-insights]').forEach(function (card) {
      var button = card.querySelector('[data-ai-insights-refresh]');
      if (button && !button.dataset.bound) {
        button.dataset.bound = '1';
        button.addEventListener('click', function () {
          loadInsights(card);
        });
      }
    });
  }

  /**
   * Fill a feedback textarea with a draft.
   *
   * It appends rather than replaces when there is already text, because the
   * instructor may have started writing and a draft that wipes their opening
   * sentence is worse than no draft.
   */
  function draftFeedback(options) {
    var textarea = options.textarea;
    var button = options.button;

    if (button) {
      button.disabled = true;
      button.dataset.original = button.innerHTML;
      button.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;"></span> Drafting…';
    }

    return WGA.post('/ai/feedback-draft', {
      courseId: options.courseId,
      submission: options.submission,
      rubric: options.rubric || '',
    })
      .then(function (data) {
        var existing = textarea.value.trim();
        textarea.value = existing ? existing + '\n\n' + data.draft : data.draft;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        if (WGAUI.toast) WGAUI.toast('Draft inserted. Edit it before sending.', 'success');
      })
      .catch(function (error) {
        if (WGAUI.toast) {
          WGAUI.toast(
            (error && error.code === 'AI_NOT_CONFIGURED')
              ? 'AI drafting is not available on this deployment yet.'
              : describeError(error),
            'error'
          );
        }
      })
      .then(function () {
        if (button) {
          button.disabled = false;
          button.innerHTML = button.dataset.original || 'Draft feedback';
        }
      });
  }

  window.WGAAI = {
    status: status,
    creditLine: creditLine,
    mountTutor: mountTutor,
    unmountTutor: unmountTutor,
    openTutor: openPanel,
    mentorPanelHTML: mentorPanelHTML,
    bindMentor: bindMentor,
    insightsHTML: insightsHTML,
    bindInsights: bindInsights,
    loadInsights: loadInsights,
    draftFeedback: draftFeedback,
    injectStyles: injectStyles,
  };
})();
