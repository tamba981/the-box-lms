'use strict';

const mongoose = require('mongoose');

const { CONTACT_REASONS } = require('../lib/constants');
const { baseOptions, lowercaseTrim } = require('./common');

/**
 * One message from the public contact form.
 *
 * Stored as well as emailed. The email is the notification; this is the record.
 * A mail provider that is misconfigured, rate-limited or simply changed should
 * not be able to lose a message somebody took the time to write, so the row is
 * written first and the send is attempted second.
 *
 * **No IP address is recorded, deliberately.** The privacy policy states that the
 * platform does not store one, and a contact form — which is reachable without an
 * account, and is the exact place a well-meaning "let us log the source" change
 * would be added — is where that promise would most easily be broken by accident.
 */
const contactMessageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { ...lowercaseTrim, required: true, maxlength: 254 },

    reason: { type: String, enum: CONTACT_REASONS, default: 'general' },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },

    /**
     * When the notification email went out. Null means it did not — the message
     * is stored and can be read, but nobody was told. Without this the only
     * evidence of a failed send is a log line nobody reads.
     */
    notifiedAt: { type: Date, default: null },

    /**
     * When an administrator marked this enquiry as dealt with.
     *
     * A queue nobody can empty is not a queue. Messages are listed newest first
     * and this is what lets somebody see what is still outstanding rather than
     * re-reading the same five enquiries every morning. Null means unresolved.
     */
    handledAt: { type: Date, default: null },
  },
  baseOptions
);

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
