#!/usr/bin/env node
'use strict';

/**
 * Test a MongoDB connection string, and never print it.
 *
 *   npm run check:mongo-uri                          # uses MONGODB_URI, or the one in .env
 *   npm run check:mongo-uri -- "$env:TEMP\uri.txt"   # uses the string in that file
 *
 * Why this exists. Diagnosing the crashed deployment meant asking whether the
 * connection string was wrong, and there was no way to answer that without the
 * value itself — which is a secret, cannot be pasted into a conversation, and
 * should not go into shell history either. So the check runs here instead.
 *
 * Reading from a file in the OS temp directory is the intended way to test a
 * candidate value: it keeps the secret out of both shell history and any file
 * that git can see.
 *
 * The password is never printed, in any branch, including error messages — some
 * driver errors echo the connection string back. Output is scrubbed of it.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/* ------------------------------------------------------------------ *
 * Scrub
 * ------------------------------------------------------------------ */

/**
 * Remove anything credential-shaped from a string before it is printed.
 *
 * Deliberately broad. A missed pattern here prints a live database password to
 * a terminal, so the cost of over-redacting is a slightly less readable error
 * message and the cost of under-redacting is a leaked secret.
 */
function scrub(text) {
  let out = String(text);

  // mongodb://user:pass@host  ->  mongodb://***:***@host
  out = out.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1***:***@');

  // Any bare password we were told about, in raw form.
  if (password) {
    out = out.split(password).join('***');
    try {
      const encoded = encodeURIComponent(password);
      if (encoded !== password) out = out.split(encoded).join('***');
    } catch {
      /* not encodable; the raw form is already handled */
    }
  }

  return out;
}

function say(line = '') {
  process.stdout.write(`${scrub(line)}\n`);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

function readDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const match = /^\s*MONGODB_URI\s*=\s*(.*)$/m.exec(fs.readFileSync(ENV_PATH, 'utf8'));
  return match && match[1].trim() ? match[1].trim() : null;
}

const fileArg = process.argv[2];
let uri = null;
let source = '';

if (fileArg) {
  if (!fs.existsSync(fileArg)) {
    process.stderr.write(`\nNo such file: ${fileArg}\n\n`);
    process.exit(2);
  }
  uri = fs.readFileSync(fileArg, 'utf8').trim().split(/\r?\n/)[0].trim();
  source = 'that file';
} else if (process.env.MONGODB_URI) {
  uri = process.env.MONGODB_URI.trim();
  source = 'the MONGODB_URI environment variable';
} else {
  uri = readDotEnv();
  source = 'backend/.env';
}

if (!uri) {
  process.stderr.write(
    '\nNo connection string found.\n\n' +
      '  npm run check:mongo-uri\n' +
      '  npm run check:mongo-uri -- <path to a file containing the string>\n\n' +
      'To test a value without putting it anywhere git can see, save it to a file\n' +
      'in your temp directory and pass that path.\n\n'
  );
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Describe it, without revealing it
 * ------------------------------------------------------------------ */

let password = '';
try {
  const parsed = new URL(uri);
  password = decodeURIComponent(parsed.password || '');
} catch {
  /* handled below */
}

process.stdout.write(`\nChecking the connection string from ${source}.\n\n`);

let parsed = null;
let parseProblem = null;

try {
  parsed = new URL(uri);
} catch (error) {
  parseProblem = error.message;
}

if (parseProblem || !/^mongodb(\+srv)?:$/.test(parsed.protocol)) {
  say(parseProblem
    ? `  The string does not parse as a URL: ${parseProblem}`
    : `  The scheme is "${parsed.protocol}", which is not mongodb:// or mongodb+srv://`);

  say(`
  This is almost always a character in the password that has to be percent-encoded.
  These must be encoded in the password portion of a connection string:

      @  ->  %40        :  ->  %3A        /  ->  %2F        ?  ->  %3F
      #  ->  %23        %  ->  %25        &  ->  %26        space -> %20

  A raw "@" is the usual culprit: the driver treats the last "@" as the separator
  between credentials and host, so a password containing one silently moves part
  of the host into the username.
`);
  process.exit(1);
}

const host = parsed.hostname || '(none)';
const database = (parsed.pathname || '').replace(/^\//, '') || '(none — this defaults to "test")';
const username = parsed.username ? decodeURIComponent(parsed.username) : '(none)';
const authSource = (parsed.searchParams.get('authSource')) || '(default: admin for Atlas)';

say(`  scheme    : ${parsed.protocol.replace(':', '')}`);
say(`  host      : ${host}`);
say(`  database  : ${database}`);
say(`  username  : ${username}`);
say(`  authSource: ${authSource}`);
say(`  password  : ${password ? `present, ${password.length} characters (never printed)` : 'ABSENT'}`);

if (!password) {
  say(`
  There is no password in this string at all. If the cluster requires
  authentication — an Atlas cluster does — this cannot connect.
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Try it
 * ------------------------------------------------------------------ */

(async () => {
  const mongoose = require('mongoose');

  say('\n  connecting...');

  const startedAt = Date.now();
  let failure = null;

  try {
    await mongoose.connect(uri, {
      // The same options the application uses, so this tests the real thing.
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 1,
      bufferCommands: false,
    });
  } catch (error) {
    failure = error;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!failure) {
    say(`  CONNECTED in ${elapsed}s.`);
    say('\nThis connection string works. If the deployment still fails with it, the\n' +
        'problem is not the credentials.\n');

    // Reading proves the account can actually read, not merely authenticate.
    try {
      const names = await mongoose.connection.db.listCollections().toArray();
      say(`  visible collections: ${names.length ? names.map((c) => c.name).join(', ') : '(none)'}`);
      say('');
    } catch (error) {
      say(`  but listing collections failed: ${error.message}`);
      say('');
    }

    await mongoose.connection.close(false);
    process.exit(0);
  }

  say(`  FAILED after ${elapsed}s.`);
  say('');
  say(`  ${failure.name}: ${failure.message}`);
  say('');

  const message = String(failure.message || '');

  if (/authentication failed|bad auth|not authorized/i.test(message)) {
    say('  The cluster was reached and it refused these credentials.\n');
    say('  This is NOT a network problem, and the timing proves it: a blocked address\n' +
        '  or an unreachable host waits out the full ten-second selection timeout,\n' +
        `  while this was answered in ${elapsed}s.\n`);
    say('  So the address is right and the password (or the username) is not:\n');
    say('    - If the Atlas password was rotated and this value was not updated, this is');
    say('      the old password. Set the current one.');
    say('    - If the password contains any of  @ : / ? # % &  or a space, it must be');
    say('      percent-encoded in the string. See the table above.');
    say('    - Check the username too, and that the database user still exists under');
    say('      Atlas -> Database Access.');
  } else if (/timed out|server selection|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    say('  The cluster could not be reached at all.\n');
    say('  That is a network or address problem, not a credential one — the opposite');
    say('  conclusion from an auth failure, and the two are worth telling apart:\n');
    say('    - Atlas -> Network Access must allow the caller. A deployment needs');
    say('      0.0.0.0/0 or the platform\'s egress addresses; your home IP is not enough.');
    say('    - Check the cluster hostname. A cluster that has been paused resolves but');
    say('      does not answer.');
  } else if (/ECONNREFUSED|closed|reset/i.test(message)) {
    say('  The address resolved but nothing accepted the connection.\n');
    say('  Usually a paused Atlas cluster, or a host that is not the cluster\'s direct');
    say('  address. Note that for Atlas you must use the direct host, never a');
    say('  "-pooler" style hostname.\n');
  } else {
    say('  Not a failure mode this script recognises. The message above is the\n' +
        '  authority; it has been scrubbed of the password.\n');
  }

  process.exit(1);
})();
