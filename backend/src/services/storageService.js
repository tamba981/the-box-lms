'use strict';

/**
 * Object storage for lesson video and material files.
 *
 * Cloudflare R2 is the target, but R2 speaks the S3 API, so this is written
 * against S3 and works against R2, S3, or any compatible provider by changing
 * STORAGE_ENDPOINT. Nothing here is R2-specific.
 *
 * Two design decisions worth understanding before changing anything:
 *
 * 1. Files never pass through this application. The browser asks for a signed
 *    URL, then PUTs the file straight to the bucket. The alternative — posting a
 *    500 MB multipart body to Express — would hold the whole file in memory,
 *    burn Railway bandwidth twice, and hit request timeouts. It also means no
 *    multipart parser is needed at all.
 *
 * 2. The bucket is private and stays private. Every read is a short-lived signed
 *    URL minted per request for someone who is allowed to watch. A permanent
 *    public URL would let any enrolled student share a paid course with the world,
 *    forever, and would make the enrolment check decorative.
 *
 * Storage is optional: the platform is fully usable with link-mode video only. So
 * every entry point here throws a message naming exactly which variables are
 * missing rather than an opaque provider error.
 */

const crypto = require('crypto');
const path = require('path');

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const config = require('../config/env');
const logger = require('../lib/logger');
const { unavailable } = require('../lib/errors');
const { ALLOWED_VIDEO_EXTENSIONS } = require('../lib/constants');

/** Upload URLs are short-lived on purpose: they are minted per file, per attempt. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

let cached = null;

function getClient() {
  if (!config.storage.enabled) return null;

  if (!cached) {
    cached = new S3Client({
      region: config.storage.region || 'auto',
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
      // R2 addresses buckets virtually-hosted, which is the SDK default. Some
      // S3-compatible providers need path-style instead, hence the override.
      forcePathStyle: config.storage.forcePathStyle === true,
    });
  }

  return cached;
}

function requireClient() {
  const client = getClient();
  if (client) return client;

  throw unavailable(
    'File storage is not configured on this deployment, so uploads are unavailable. ' +
      'Use a YouTube or Vimeo link for this lesson instead.',
    {
      code: 'STORAGE_NOT_CONFIGURED',
      details: config.storage.missing.map((name) => ({
        field: name,
        message: `${name} is not set`,
      })),
    }
  );
}

/** What a page needs to decide whether to offer an upload button at all. */
function describeStatus() {
  return {
    enabled: config.storage.enabled,
    provider: config.storage.provider || null,
    missing: config.storage.missing,
    videoMaxBytes: config.storage.videoMaxBytes,
    uploadUrlTtlSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

/**
 * The extension is taken from an allowlist, never from the supplied filename.
 *
 * A filename is attacker-controlled text. Using it — even its extension — is how
 * `../../` and `.php` reach a bucket, and it also lets someone upload an
 * `image/svg+xml` and call it `.jpg`.
 */
function safeExtension(filename, allowed) {
  const extension = path.extname(String(filename || '')).replace('.', '').toLowerCase();
  return allowed.includes(extension) ? extension : allowed[0];
}

/**
 * Keys are random, not derived from the lesson title.
 *
 * A guessable key is a second way past a private bucket if a policy is ever
 * loosened by accident, and it leaks the course structure to anyone who sees one
 * URL. `crypto.randomUUID` costs nothing.
 */
function buildKey({ courseId, lessonId, purpose, filename, allowedExtensions }) {
  const extension = safeExtension(filename, allowedExtensions);
  const scope = purpose === 'material' ? 'materials' : 'video';
  return `courses/${courseId}/lessons/${lessonId}/${scope}/${crypto.randomUUID()}.${extension}`;
}

function buildVideoKey({ courseId, lessonId, filename }) {
  return buildKey({
    courseId,
    lessonId,
    purpose: 'video',
    filename,
    allowedExtensions: ALLOWED_VIDEO_EXTENSIONS,
  });
}

function buildMaterialKey({ courseId, lessonId, filename }) {
  return buildKey({
    courseId,
    lessonId,
    purpose: 'material',
    filename,
    allowedExtensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'csv', 'zip'],
  });
}

/**
 * A signed PUT the browser can send the file to directly.
 *
 * The Content-Type is part of the signature. The client must send back exactly
 * this value or the bucket rejects the request with a signature mismatch that
 * looks nothing like a content-type problem — so the caller has to echo it.
 */
async function createUploadUrl({ key, contentType, expiresIn = UPLOAD_URL_TTL_SECONDS }) {
  const client = requireClient();

  const command = new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, command, { expiresIn });

  return { url, key, expiresIn, contentType };
}

/**
 * A signed GET, minted per request and expiring quickly.
 *
 * `disposition: 'inline'` lets a video element stream it; `attachment` makes the
 * browser save a material file instead of rendering it.
 */
async function createDownloadUrl(
  key,
  { filename, disposition = 'inline', expiresIn = config.storage.urlTtlSeconds } = {}
) {
  if (!key) return null;

  const client = requireClient();

  const command = new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    ResponseContentDisposition: filename
      ? `${disposition}; filename="${String(filename).replace(/["\\\r\n]/g, '')}"`
      : disposition,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Confirm an upload actually happened and learn its real size.
 *
 * This is the check that makes the client's word unnecessary: the browser says it
 * uploaded a file, and the bucket is asked. Without it, a client could claim a
 * 500 MB upload that never occurred, or one larger than the cap.
 */
async function statObject(key) {
  const client = requireClient();

  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key })
    );
    return {
      exists: true,
      size: Number(head.ContentLength) || 0,
      contentType: head.ContentType || '',
    };
  } catch (error) {
    const status = error && error.$metadata ? error.$metadata.httpStatusCode : undefined;
    if (status === 404 || (error && error.name === 'NotFound')) {
      return { exists: false, size: 0, contentType: '' };
    }
    throw error;
  }
}

/**
 * Best-effort removal. Never throws.
 *
 * A bucket delete that fails should not fail the request that triggered it: the
 * lesson is already gone or already reassigned, and an orphaned object is a
 * housekeeping problem, not a user-facing error. It is logged so it can be found.
 */
async function deleteObject(key) {
  if (!key) return false;

  const client = getClient();
  if (!client) return false;

  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return true;
  } catch (error) {
    logger.warn('could not delete an object; it is now orphaned', {
      key,
      error: error && error.message,
    });
    return false;
  }
}

module.exports = {
  describeStatus,
  buildVideoKey,
  buildMaterialKey,
  createUploadUrl,
  createDownloadUrl,
  statObject,
  deleteObject,
  UPLOAD_URL_TTL_SECONDS,
};
