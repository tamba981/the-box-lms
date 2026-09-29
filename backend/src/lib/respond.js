'use strict';

/**
 * Response envelope.
 *
 * The shape `{ success, message, data }` is retained deliberately: the existing
 * pages in frontend/public already parse it, so keeping it means sign-in keeps
 * working while everything behind it is replaced.
 */

function ok(res, data = null, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}

function created(res, data = null, message = 'Created') {
  return res.status(201).json({ success: true, message, data });
}

function noContent(res, message = 'Done') {
  return res.status(200).json({ success: true, message, data: null });
}

module.exports = { ok, created, noContent };
