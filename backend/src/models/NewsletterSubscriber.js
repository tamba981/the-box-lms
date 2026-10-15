'use strict';

const mongoose = require('mongoose');

const { baseOptions, lowercaseTrim } = require('./common');

/**
 * One newsletter subscriber.
 *
 * The address is unique and stored lowercase, so the same person subscribing
 * twice is one row rather than two, and `User@Example.COM ` cannot slip past as
 * a second subscriber.
 *
 * `unsubscribedAt` exists from the start even though nothing sets it yet. A list
 * that cannot record a withdrawal cannot honour one, and adding the column later
 * means migrating live rows. There is no unsubscribe endpoint yet; this only
 * makes one possible without a schema change.
 */
const newsletterSubscriberSchema = new mongoose.Schema(
  {
    email: { ...lowercaseTrim, required: true, unique: true, maxlength: 254 },

    /** Which page they subscribed from, so a future send can be attributed. */
    source: { ...lowercaseTrim, default: 'index' },

    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  baseOptions
);

module.exports = mongoose.model('NewsletterSubscriber', newsletterSubscriberSchema);
