/**
 * Is this address one we are willing to put inside an iframe?
 *
 * The check was written inline in the course validator, where it guards lesson
 * video links. Instructor introductions need the same rule, so it lives here now
 * and both callers share it — one implementation, one set of tricks defeated.
 *
 * The host is compared exactly against an allowlist rather than searched for in
 * the string. `https://youtube.com.evil.example/` and
 * `https://evil.example/?x=youtube.com` both contain "youtube.com" and neither
 * is YouTube; `new URL` resolves each to the host it actually is.
 */

const { EMBEDDABLE_VIDEO_HOSTS } = require('./constants');

function isEmbeddableVideoUrl(value) {
  if (!value || typeof value !== 'string') return false;

  try {
    const { protocol, hostname } = new URL(value);

    if (protocol !== 'https:' && protocol !== 'http:') return false;

    const bare = hostname.toLowerCase().replace(/^www\./, '');
    return EMBEDDABLE_VIDEO_HOSTS.includes(bare);
  } catch {
    return false;
  }
}

module.exports = { isEmbeddableVideoUrl };
