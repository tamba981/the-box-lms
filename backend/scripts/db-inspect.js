#!/usr/bin/env node
'use strict';

/**
 * Report what is actually in the database this configuration points at.
 *
 *   npm run db:inspect
 *   npm run db:inspect -- wuteve_dev        # compare against another database
 *
 * Why this exists. This project's database has been renamed once already — it was
 * `thebox_lms` and became `wuteve_dev` — and both still exist on the same cluster.
 * So two deployments can be healthy, connected, and serving completely different
 * data, and the only visible symptom is an empty catalogue. "Connected" and
 * "connected to the right place" are different facts and this reports the second.
 *
 * It prints the database name, a count per collection, and the parts of the data
 * that decide whether a site looks finished: published courses, and accounts by
 * role. It never prints the connection string or the password.
 */

const path = require('path');

require(path.join(__dirname, '..', 'src', 'config', 'env'));

const mongoose = require('mongoose');

const currentUri = process.env.MONGODB_URI || '';
const otherDatabase = process.argv[2] || null;

if (!currentUri) {
  process.stderr.write('\nMONGODB_URI is not set, so there is nothing to inspect.\n\n');
  process.exit(2);
}

/** Replace the database name without touching the credentials. */
function withDatabase(uri, name) {
  const parsed = new URL(uri);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function databaseName(uri) {
  return new URL(uri).pathname.replace(/^\//, '') || '(none — this defaults to "test")';
}

async function inspect(uri, label) {
  const name = databaseName(uri);

  process.stdout.write(`\n${label}\n${'-'.repeat(label.length)}\n`);
  process.stdout.write(`  database: ${name}\n`);

  const startedAt = Date.now();
  const connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    maxPoolSize: 2,
    bufferCommands: false,
  }).asPromise();

  process.stdout.write(`  connected in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n\n`);

  const db = connection.db;
  const collections = await db.listCollections().toArray();

  let total = 0;
  const counts = [];

  for (const { name: collection } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    // eslint-disable-next-line no-await-in-loop
    const count = await db.collection(collection).countDocuments();
    total += count;
    counts.push([collection, count]);
  }

  for (const [collection, count] of counts) {
    const flag = count === 0 ? '   (empty)' : '';
    process.stdout.write(`    ${collection.padEnd(20)} ${String(count).padStart(6)}${flag}\n`);
  }

  process.stdout.write(`    ${'TOTAL'.padEnd(20)} ${String(total).padStart(6)}\n`);

  /**
   * The three facts that decide whether the site looks alive. A healthy
   * connection to an empty database presents as an empty catalogue and nothing
   * else, which reads as a bug in the catalogue rather than as the wrong
   * database.
   */
  const courses = await db.collection('courses');
  const published = await courses.countDocuments({ status: 'published' });
  const paid = await courses.countDocuments({ status: 'published', priceCents: { $gt: 0 } });

  const users = await db.collection('users');
  const admins = await users.countDocuments({ role: 'admin' });
  const instructors = await users.countDocuments({ role: 'instructor' });
  const students = await users.countDocuments({ role: 'student' });

  process.stdout.write(`\n  published courses: ${published} (${paid} of them paid)\n`);
  process.stdout.write(`  accounts         : ${admins} admin, ${instructors} instructor, ${students} student\n`);

  if (published === 0) {
    process.stdout.write(
      '\n  An empty catalogue. A site pointed here would load, connect, and show\n' +
        '  nothing — which looks like a broken catalogue rather than the wrong database.\n'
    );
  }
  if (admins > 0) {
    process.stdout.write(
      `\n  ${admins} administrator account(s) exist here. If this database is used for\n` +
        '  the public deployment, check that none of them still carries a demo\n' +
        '  password that has been published anywhere.\n'
    );
  }

  await connection.close();
}

(async () => {
  try {
    await inspect(currentUri, `Configured in backend/.env`);

    if (otherDatabase) {
      await inspect(withDatabase(currentUri, otherDatabase), `Compared with "${otherDatabase}"`);
      process.stdout.write(
        '\nDeployments point wherever MONGODB_URI says. Setting it in one place and not\n' +
          'the other is how a healthy deployment ends up serving an empty catalogue.\n\n'
      );
    } else {
      process.stdout.write('\n');
    }
  } catch (error) {
    process.stderr.write(`\n${error.name}: ${error.message}\n\n`);
    process.exit(1);
  }
})();
