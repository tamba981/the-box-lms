/**
 * A CV travelling as a data URL.
 *
 * Same shape as `avatar.js`, and for the same reason: there is no multipart
 * parser on this deployment, so the file rides inside JSON as base64. That puts
 * a hard ceiling on the size — `express.json` refuses a body over 1 MB — which
 * is why the limit here is 500 KB of PDF rather than anything larger.
 *
 * Nothing the client says about the file is trusted. `application/pdf` in a data
 * URL prefix is a claim, not evidence, so the bytes are inspected: a PDF begins
 * with `%PDF-` and ends with `%%EOF`, and both are checked.
 */

const MAX_CV_BYTES = 500 * 1024;

/**
 * The base64 of a 500 KB file is ~683k characters; 700k leaves room for the
 * data-URL prefix without admitting a file that would then fail the byte check.
 */
const MAX_CV_DATA_URL_CHARS = 700 * 1000;

const PDF_MAGIC = '%PDF-';
const PDF_TAIL = '%%EOF';

/**
 * Only the section between the comma and the end is base64. The prefix is read
 * so a mislabelled file can be refused before anything is decoded.
 */
function splitDataUrl(value) {
  const comma = value.indexOf(',');
  if (comma === -1) return null;

  const header = value.slice(0, comma).toLowerCase();
  if (!header.startsWith('data:')) return null;
  if (!header.endsWith(';base64')) return null;

  return { mediaType: header.slice(5, -7), base64: value.slice(comma + 1) };
}

function decodeCv(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    return { ok: false, message: 'Choose a PDF file to upload.' };
  }

  if (dataUrl.length > MAX_CV_DATA_URL_CHARS) {
    return { ok: false, message: 'That file is too large. The CV must be a PDF under 500 KB.' };
  }

  const parts = splitDataUrl(dataUrl);
  if (!parts) {
    return { ok: false, message: 'That file could not be read. Upload a PDF.' };
  }

  if (parts.mediaType !== 'application/pdf') {
    return { ok: false, message: 'Only PDF files are accepted. Export your CV as a PDF and try again.' };
  }

  let buffer;
  try {
    buffer = Buffer.from(parts.base64, 'base64');
  } catch {
    return { ok: false, message: 'That file could not be read. Upload a PDF.' };
  }

  if (buffer.length === 0) {
    return { ok: false, message: 'That file is empty.' };
  }

  if (buffer.length > MAX_CV_BYTES) {
    return { ok: false, message: 'That file is too large. The CV must be a PDF under 500 KB.' };
  }

  // A PDF may carry a few bytes of preamble before the signature, but not 1 KB.
  if (!buffer.subarray(0, 1024).includes(Buffer.from(PDF_MAGIC, 'latin1'))) {
    return { ok: false, message: 'That is not a PDF. Export your CV as a PDF and try again.' };
  }

  // A truncated or renamed file often keeps the header; the trailer is the
  // cheap way to notice that the document does not actually end.
  if (!buffer.subarray(Math.max(0, buffer.length - 1024)).includes(Buffer.from(PDF_TAIL, 'latin1'))) {
    return { ok: false, message: 'That PDF looks incomplete. Re-export it and try again.' };
  }

  return { ok: true, buffer };
}

/**
 * The name to store alongside the file.
 *
 * Path separators and control characters go, because the value is echoed back
 * in a Content-Disposition header; everything else that survives is harmless.
 */
function sanitiseFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);

  return cleaned || 'cv.pdf';
}

module.exports = { MAX_CV_BYTES, MAX_CV_DATA_URL_CHARS, decodeCv, sanitiseFilename };
