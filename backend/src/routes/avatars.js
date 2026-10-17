'use strict';

const express = require('express');

const User = require('../models/User');
const { asyncHandler } = require('../lib/asyncHandler');
const { notFound } = require('../lib/errors');

const router = express.Router();

/**
 * A profile picture, by key.
 *
 * Public, because an `<img>` tag cannot send an Authorization header, and the
 * alternative — fetching every avatar through JavaScript and turning it into an
 * object URL — costs more than it protects. The exposure is bounded on purpose:
 *
 *   - the address is a random 128-bit key, not the user id, so it cannot be used
 *     to walk the user table or to confirm that an account exists
 *   - uploading again mints a new key, so an image can be withdrawn by replacing
 *     it, and an old address stops resolving
 *   - nothing but the image is returned: no name, no email, no identifiers
 *
 * `immutable` is honest here: the key changes whenever the picture does, so this
 * exact URL can never need to be fetched twice.
 */
router.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const key = String(req.params.key || '').toLowerCase();

    if (!/^[a-f0-9]{32}$/.test(key)) {
      throw notFound('That photo could not be found.', { code: 'AVATAR_NOT_FOUND' });
    }

    const user = await User.findOne({ avatarKey: key }).select('avatarImage avatarContentType');

    if (!user || !user.avatarImage || user.avatarImage.length === 0) {
      throw notFound('That photo could not be found.', { code: 'AVATAR_NOT_FOUND' });
    }

    res.set('Content-Type', user.avatarContentType || 'image/png');
    res.set('Content-Length', String(user.avatarImage.length));
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // The bytes were sniffed on the way in, but never let a browser re-decide.
    res.set('X-Content-Type-Options', 'nosniff');

    return res.send(user.avatarImage);
  })
);

module.exports = router;
