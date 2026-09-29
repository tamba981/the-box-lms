'use strict';

/**
 * Shared schema plumbing.
 *
 * Every document is serialised to the client through the same transform, so
 * the API always speaks `id` (string) rather than `_id`/`__v`, and no schema
 * has to remember to strip internals itself.
 */

function transform(doc, ret) {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  return ret;
}

const baseOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: { virtuals: true, transform },
  toObject: { virtuals: true, transform },
};

/** Force a field to store lowercase-trimmed text (emails, slugs, categories). */
const lowercaseTrim = {
  type: String,
  lowercase: true,
  trim: true,
};

module.exports = { baseOptions, transform, lowercaseTrim };
