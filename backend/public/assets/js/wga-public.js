/* ==========================================================================
   wga-public.js - behaviour shared by the marketing pages.

   index.html, for-individuals.html, business.html, universities.html and
   government.html all need the same six things: a working header, the theme
   toggle, the footer year, reveal-on-scroll, the newsletter form and a lead
   form. They each used to carry their own copy of this, which is how one page
   ended up with a carousel nobody maintained and another with a menu button
   that only worked after a second click.

   Everything here is opt-in by attribute, so a page that includes this file but
   has none of the markup is unaffected:

     [data-mega]           button that opens the mega menu
     [data-mega-menu]      the panel it opens
     [data-menu-btn]       mobile menu button
     [data-mobile-nav]     the drawer it opens
     [data-when-signed-in]  shown only to a signed-in visitor
     [data-when-signed-out] shown only to everybody else
     [data-logout]         signs out
     [data-reveal]         fades in when scrolled to
     form[data-newsletter] newsletter subscribe
     form[data-lead]       partnership enquiry (POST /business/enquiries)

   Depends on wga-api.js (WGA) and wga-ui.js (WGAUI), both loaded before it.
   ========================================================================== */

(function (window, document) {
  'use strict';

  var WGA = window.WGA;
  var WGAUI = window.WGAUI;

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /* ---------------------------------------------------------------- *
   * Header: mega menu, mobile drawer, current page
   * ---------------------------------------------------------------- */

  function initHeader() {
    var megaButton = qs('[data-mega]');
    var mega = qs('[data-mega-menu]');
    var menuButton = qs('[data-menu-btn]');
    var drawer = qs('[data-mobile-nav]');

    function closeMega() {
      if (!mega) return;
      mega.classList.remove('open');
      if (megaButton) megaButton.setAttribute('aria-expanded', 'false');
    }

    function openMega() {
      if (!mega) return;
      mega.classList.add('open');
      if (megaButton) megaButton.setAttribute('aria-expanded', 'true');
    }

    if (megaButton && mega) {
      megaButton.addEventListener('click', function (event) {
        event.preventDefault();
        if (mega.classList.contains('open')) closeMega();
        else openMega();
      });

      // A menu that only closes on a second click of the same button is a menu
      // people get stuck inside, so anything else that looks like "away" closes
      // it: a click elsewhere, Escape, or following one of its links.
      document.addEventListener('click', function (event) {
        if (!mega.classList.contains('open')) return;
        if (mega.contains(event.target) || megaButton.contains(event.target)) return;
        closeMega();
      });

      mega.addEventListener('click', function (event) {
        if (event.target.closest('a')) closeMega();
      });

      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        if (!mega.classList.contains('open')) return;
        closeMega();
        megaButton.focus();
      });
    }

    if (menuButton && drawer) {
      /**
       * Say that the drawer scrolls.
       *
       * On a phone the drawer is taller than the screen, and the links below the
       * fold were invisible: people saw "All courses" and concluded that was the
       * whole menu. The chip appears only when there is something further down,
       * and disappears at the end, so it never lies about what is below.
       */
      var moreHint = document.createElement('p');
      moreHint.className = 'mobile-nav-more';
      moreHint.setAttribute('aria-hidden', 'true');
      moreHint.textContent = 'Scroll for more';
      moreHint.hidden = true;
      drawer.appendChild(moreHint);

      function updateMoreHint() {
        if (!drawer.classList.contains('open')) {
          moreHint.hidden = true;
          return;
        }

        var remaining = drawer.scrollHeight - drawer.scrollTop - drawer.clientHeight;
        moreHint.hidden = remaining < 24;
      }

      drawer.addEventListener('scroll', updateMoreHint, { passive: true });
      window.addEventListener('resize', updateMoreHint);

      function setDrawer(open) {
        drawer.classList.toggle('open', open);
        menuButton.setAttribute('aria-expanded', String(open));
        menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        document.body.style.overflow = open ? 'hidden' : '';

        if (open) {
          drawer.scrollTop = 0;
          // Wait for display:block to be painted, or the measurements are zero.
          window.requestAnimationFrame(updateMoreHint);
        } else {
          moreHint.hidden = true;
        }
      }

      menuButton.addEventListener('click', function () {
        setDrawer(!drawer.classList.contains('open'));
      });

      drawer.addEventListener('click', function (event) {
        if (event.target.closest('a')) setDrawer(false);
      });

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && drawer.classList.contains('open')) {
          setDrawer(false);
          menuButton.focus();
        }
      });

      // Rotating a phone back to landscape leaves a full-height drawer over a
      // page that now has room for the real navigation.
      window.addEventListener('resize', function () {
        if (window.innerWidth > 980 && drawer.classList.contains('open')) setDrawer(false);
      });
    }

    // aria-current on the nav link for the page being viewed, so the header says
    // where you are without any page needing to hard-code it.
    var path = window.location.pathname.replace(/\/+$/, '') || '/index.html';
    qsa('.pub-nav a, .mobile-nav a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      var target = href.split('#')[0].replace(/\/+$/, '');
      if (target && (target === path || (path === '/index.html' && target === '/index'))) {
        link.setAttribute('aria-current', 'page');
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Account state
   *
   * The marketing header shows "Sign in" and "Create account" to a stranger and
   * "Dashboard" plus a sign-out control to somebody who is already in. Deciding
   * from localStorage is enough here: nothing is protected on these pages, and
   * the dashboards re-check the session against the server themselves.
   * ---------------------------------------------------------------- */

  function initAccount() {
    var signedIn = Boolean(WGA && WGA.isSignedIn && WGA.isSignedIn());
    var user = signedIn && WGA.getUser ? WGA.getUser() : null;
    var name = user && user.firstName ? String(user.firstName) : '';

    qsa('[data-when-signed-in]').forEach(function (node) {
      node.hidden = !signedIn;
    });

    qsa('[data-when-signed-out]').forEach(function (node) {
      node.hidden = signedIn;
    });

    qsa('[data-account-name]').forEach(function (node) {
      node.textContent = name ? 'Hi, ' + name : 'Dashboard';
    });

    qsa('[data-dashboard-link]').forEach(function (link) {
      // Instructors and administrators land on their own console, not the
      // student dashboard they cannot use. `homeForRole` in wga-api.js already
      // knows the mapping, so it is asked rather than restated here.
      var role = user && user.role;
      link.setAttribute('href', WGA.homeForRole ? WGA.homeForRole(role) : '/student-dashboard.html');
    });

    qsa('[data-logout]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        button.disabled = true;
        Promise.resolve(WGA.logout()).then(function () {
          window.location.href = '/index.html';
        });
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Reveal on scroll. Deliberately tiny and one-directional: it adds a class
   * once and unobserves. If IntersectionObserver is missing the class is added
   * immediately, because hidden content is a worse failure than no animation.
   * ---------------------------------------------------------------- */

  function initReveal() {
    var items = qsa('[data-reveal]');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      items.forEach(function (item) {
        item.classList.add('shown');
      });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('shown');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
    );

    items.forEach(function (item) {
      observer.observe(item);
    });
  }

  /* ---------------------------------------------------------------- *
   * Newsletter
   * ---------------------------------------------------------------- */

  function initNewsletter() {
    var form = qs('form[data-newsletter]');
    if (!form) return;

    var input = qs('input[type="email"]', form);
    var button = qs('button[type="submit"]', form);
    var status = qs('[data-newsletter-status]');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!input.value.trim()) {
        if (status) status.textContent = 'Enter your email address first.';
        input.focus();
        return;
      }

      button.disabled = true;
      if (status) status.textContent = 'Adding you...';

      WGA.post('/newsletter/subscribe', { email: input.value.trim(), source: 'public-site' })
        .then(function (response) {
          form.reset();
          if (status) {
            status.textContent = (response && response.message) || 'You are on the list.';
          }
        })
        .catch(function (error) {
          if (status) status.textContent = (error && error.message) || 'That did not work. Please try again.';
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  /* ---------------------------------------------------------------- *
   * Partnership enquiry form
   *
   * One handler for the three audience pages. The page declares which audience
   * it is with a hidden input, so the same code serves all of them and the email
   * arrives labelled.
   * ---------------------------------------------------------------- */

  function initLeadForm() {
    var form = qs('form[data-lead]');
    if (!form) return;

    var button = qs('button[type="submit"]', form);
    var status = qs('[data-lead-status]');
    var done = qs('[data-lead-done]');

    function showStatus(message, kind) {
      if (!status) return;
      status.textContent = message;
      status.className = 'form-status show ' + (kind === 'ok' ? 'is-ok' : 'is-error');
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (status) {
        status.className = 'form-status';
        status.textContent = '';
      }

      var data = new FormData(form);
      var interests = data.getAll('interests').filter(function (value) {
        return String(value).trim() !== '';
      });

      var payload = {
        audience: String(data.get('audience') || 'business'),
        company: String(data.get('company') || '').trim(),
        contactName: String(data.get('contactName') || '').trim(),
        email: String(data.get('email') || '').trim(),
        phone: String(data.get('phone') || '').trim(),
        teamSize: String(data.get('teamSize') || '').trim(),
        timeline: String(data.get('timeline') || '').trim(),
        interests: interests,
        message: String(data.get('message') || '').trim(),
      };

      button.disabled = true;
      button.textContent = 'Sending...';

      WGA.post('/business/enquiries', payload)
        .then(function (response) {
          form.hidden = true;
          if (done) {
            done.hidden = false;
            var ref = qs('[data-lead-reference]', done);
            if (ref && response && response.reference) {
              ref.textContent = 'Your reference: ' + response.reference;
            }
          }
          showStatus((response && response.message) || 'Thank you - we will be in touch.', 'ok');
        })
        .catch(function (error) {
          var details = error && error.details;
          if (details && details.length && WGAUI && WGAUI.showFieldErrors) {
            WGAUI.showFieldErrors(form, details);
          }
          showStatus(
            (error && error.message) || 'That did not send. Please try again, or email us directly.',
            'error'
          );
        })
        .then(function () {
          button.disabled = false;
          button.textContent = button.getAttribute('data-label') || 'Send enquiry';
        });
    });
  }

  /* ---------------------------------------------------------------- *
   * Footer year
   * ---------------------------------------------------------------- */

  function initYear() {
    qsa('[data-year]').forEach(function (node) {
      node.textContent = String(new Date().getFullYear());
    });
  }

  function init() {
    if (WGAUI && WGAUI.initTheme) WGAUI.initTheme();
    initHeader();
    initAccount();
    initReveal();
    initNewsletter();
    initLeadForm();
    initYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.WGAPublic = { init: init };
})(window, document);
