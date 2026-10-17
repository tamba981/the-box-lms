'use strict';

/**
 * Avatar decoding.
 *
 * Two things are non-negotiable here.
 *
 * The first is that the declared type is never trusted. A caller can label a
 * zip file `image/png`; the bytes are what get sniffed, and only the three
 * formats a browser can definitely render are accepted. SVG is deliberately
 * absent: an SVG is a document that can carry script, and serving one from this
 * origin would turn a profile picture into stored cross-site scripting.
 *
 * The second is that the size is bounded before the work is done. Base64
 * inflates by a third, so the string is measured before it is decoded; a
 * request that cannot possibly be small enough is refused without allocating
 * anything for it.
 *
 * Images live in MongoDB rather than object storage because storage is not
 * configured on this deployment, and a picture that cannot be uploaded is worth
 * less than a small one that can. 120 KB is about four times what a 256×256
 * photograph needs, which leaves room for a client that skips the resizing
 * step — and catches one that does not try at all.
 */

const MAX_AVATAR_BYTES = 120 * 1024;

/** Base64 is 4 characters per 3 bytes, plus the data-URL prefix. */
const MAX_DATA_URL_CHARS = Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 256;

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * What the bytes actually are, whatever they were labelled.
 *
 * Returns null for anything that is not one of the accepted formats.
 */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;

  if (buffer.length >= 8 && PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    return 'image/png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Turn a data URL into bytes, or explain why it cannot be used.
 *
 * Always returns a shape the caller can act on rather than throwing, because
 * every branch here is a refusal the student should be able to read.
 */
function decodeAvatar(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  const value = dataUrl.trim();

  if (value.length > MAX_DATA_URL_CHARS) {
    return { ok: false, message: 'That image is too large. Choose one under 120 KB.' };
  }

  const match = DATA_URL.exec(value);
  if (!match) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  const buffer = Buffer.from(match[2], 'base64');

  if (buffer.length === 0) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  if (buffer.length > MAX_AVATAR_BYTES) {
    return { ok: false, message: 'That image is too large. Choose one under 120 KB.' };
  }

  // The sniffed type wins over the label, always.
  const contentType = sniffImageType(buffer);
  if (!contentType) {
    return { ok: false, message: 'Upload a PNG, JPEG or WebP image.' };
  }

  return { ok: true, buffer, contentType };
}

module.exports = {
  MAX_AVATAR_BYTES,
  MAX_DATA_URL_CHARS,
  decodeAvatar,
  sniffImageType,
};
