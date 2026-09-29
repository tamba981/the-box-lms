'use strict';

const mongoose = require('mongoose');

const { baseOptions } = require('./common');

/**
 * Atomic counters.
 *
 * Certificate serial numbers must be sequential and gap-free-ish, which means
 * "read the current value and add one" cannot be done with a find-then-save —
 * two simultaneous completions would produce the same number. `$inc` is atomic
 * in MongoDB, so a single findOneAndUpdate hands out each value exactly once.
 */
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Number, default: 0 },
  },
  baseOptions
);

/** @returns {Promise<number>} the next value in the named sequence */
counterSchema.statics.next = async function next(key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return doc.value;
};

module.exports = mongoose.model('Counter', counterSchema);
