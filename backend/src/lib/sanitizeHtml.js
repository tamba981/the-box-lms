'use strict';

/**
 * Lesson bodies are HTML, and the HTML comes from an instructor's browser.
 *
 * A rich text editor produces markup, and markup from a browser is untrusted no
 * matter how trustworthy the person typing into it is. It travels through an API
 * that anyone with an instructor token can call directly — the editor is a
 * convenience, not a boundary. So the filter lives here, on the server, and the
 * client-side editor is not relied on for anything security-related.
 *
 * The policy is an allowlist, not a blocklist. A blocklist of "dangerous tags"
 * is a losing game: `<img src=x onerror=…>`, `<svg/onload=…>`, `<a href="javascript:…">`,
 * CSS `url(javascript:…)`, mutation XSS through mis-nesting — each one is a new
 * entry, and the day you miss one is the day a student's session is stolen.
 * Anything not named below does not survive.
 *
 * Notes on the choices:
 *
 *   - `style` is not allowed on any tag. Quill expresses alignment as `ql-*`
 *     classes, so nothing needs inline CSS, and excluding it removes a whole
 *     class of parser-differential attack.
 *   - Only `ql-*` classes are allowed, and only on the tags Quill puts them on.
 *   - Links may only be http, https or mailto. `javascript:` and `data:` are
 *     dropped, which is what stops a lesson from carrying a script link.
 *   - Every surviving link gets `rel="noopener noreferrer"`: a lesson that opens
 *     in a new tab must not hand `window.opener` to the destination.
 *   - Images are deliberately not allowed. There is no image upload, and an
 *     external image is a tracking pixel that reports every student who opens
 *     the lesson.
 */

const sanitizeHtml = require('sanitize-html');

/** The subset of Quill's output this application actually uses. */
const ALLOWED_TAGS = [
  'p', 'br',
  'strong', 'b', 'em', 'i', 'u', 's',
  'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'a',
  'blockquote',
  'code', 'pre',
];

/** Quill's alignment classes, and only the tags it applies them to. */
const ALIGN_CLASSES = ['ql-align-center', 'ql-align-right', 'ql-align-justify'];

const OPTIONS = {
  allowedTags: ALLOWED_TAGS,

  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    p: ['class'],
    h2: ['class'],
    h3: ['class'],
    h4: ['class'],
    li: ['class'],
  },

  allowedClasses: {
    p: ALIGN_CLASSES,
    h2: ALIGN_CLASSES,
    h3: ALIGN_CLASSES,
    h4: ALIGN_CLASSES,
    li: ALIGN_CLASSES,
  },

  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,

  // Drop the tag but keep the text inside it: a banned <script> should not take
  // the paragraph around it with it, and a banned <div> should not swallow the
  // words it wrapped.
  disallowedTagsMode: 'discard',

  transformTags: {
    a: (tagName, attribs) => {
      const href = String(attribs.href || '').trim();

      /**
       * Decide the scheme here rather than leaving it to `allowedSchemes`.
       *
       * `allowedSchemes` drops the dangerous `href` but keeps the `<a>`, which
       * leaves a link that looks clickable and does nothing — and leaves the
       * browser to interpret a dangling anchor. Checking first means a rejected
       * address loses the element as well, so the result is plain text.
       */
      const scheme = (href.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
      const usable = href && (!scheme || ['http', 'https', 'mailto'].includes(scheme.toLowerCase()));

      if (!usable) return { tagName: 'span', attribs: {} };

      return {
        tagName: 'a',
        attribs: {
          href,
          ...(attribs.title ? { title: attribs.title } : {}),
          // Only ever open away from this page with a hard opener guarantee.
          ...(attribs.target === '_blank' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        },
      };
    },
  },
};

/**
 * Sanitize lesson HTML for storage.
 *
 * Returns a string that is safe to insert with `innerHTML`. An empty result is a
 * legitimate outcome — a body of nothing but `<script>` legitimately becomes
 * nothing — so callers must not treat '' as an error.
 */
function sanitizeLessonHtml(dirty) {
  if (typeof dirty !== 'string' || !dirty.trim()) return '';
  return sanitizeHtml(dirty, OPTIONS).trim();
}

/**
 * Does this body contain markup at all?
 *
 * Lesson bodies written before the editor existed are plain text, and the reader
 * escapes them. Bodies written after are HTML. The client needs to tell them
 * apart, and guessing from the presence of any `<` would be wrong for a lesson
 * about the shell. This asks for a tag-shaped sequence instead.
 */
function looksLikeHtml(value) {
  return typeof value === 'string' && /<([a-z][a-z0-9]*)\b[^>]*>/i.test(value);
}

module.exports = { sanitizeLessonHtml, looksLikeHtml, ALLOWED_TAGS, OPTIONS };
