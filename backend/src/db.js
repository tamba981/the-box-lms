'use strict';

const mongoose = require('mongoose');

const config = require('./config/env');
const logger = require('./lib/logger');

/**
 * Mongoose connection lifecycle.
 *
 * The previous server called `mongoose.connect(...)` and then started
 * listening immediately, so the process came up "healthy" even with no
 * database. Here, `connect()` is awaited before the HTTP server starts.
 */

// Note: `sanitizeFilter` is deliberately NOT enabled. It wraps *every* filter
// value in `$eq`, which silently breaks the legitimate server-side queries this
// API relies on (`{ createdAt: { $gte: ... } }`, `{ _id: { $in: [...] } }`).
// Query injection is instead prevented at the edge: every request body, query
// string and route param is parsed by a Zod schema with explicit scalar types,
// so an object can never reach a query as a `$`-operator.
mongoose.set('strictQuery', true);

let connection = null;

async function connect() {
  if (connection) return connection;

  mongoose.connection.on('connected', () => logger.info('mongodb connected'));
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongodb reconnected'));
  mongoose.connection.on('error', (error) => logger.error('mongodb error', { error }));

  connection = await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    // Buffering off: a query issued while disconnected fails fast with a clear
    // error instead of hanging until the 10s timeout.
    bufferCommands: false,
  });

  return connection;
}

async function disconnect() {
  if (!connection) return;
  await mongoose.connection.close(false);
  connection = null;
  logger.info('mongodb connection closed');
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

/** 1 = connected, 2 = connecting, 0 = disconnected, 3 = disconnecting. */
function state() {
  const value = mongoose.connection.readyState;
  return { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[value] || 'unknown';
}

module.exports = { connect, disconnect, isConnected, state, mongoose };
