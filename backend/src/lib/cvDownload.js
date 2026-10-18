/**
 * Hand a CV to the browser as a download.
 *
 * Shared by the two ways a CV may be fetched — the owner's own copy and an
 * administrator's review copy — so the headers and the filename are decided in
 * one place. A CV is personal data: the response is marked `no-store` so it is
 * not left in a shared cache, and the filename carries the person's name rather
 * than whatever they called the file on their machine.
 */

const CONTENT_TYPE = 'application/pdf';

function cvFileName(user) {
  const name = `${user.firstName || ''} ${user.lastName || ''}`
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  return `${name || 'instructor'}-cv.pdf`;
}

function sendCv(res, user) {
  res.set('Content-Type', CONTENT_TYPE);
  res.set('Content-Disposition', `attachment; filename="${cvFileName(user)}"`);
  res.set('Content-Length', String(user.cvImage.length));
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.end(user.cvImage);
}

module.exports = { CONTENT_TYPE, cvFileName, sendCv };
