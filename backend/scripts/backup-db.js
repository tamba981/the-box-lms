'use strict';

/**
 * Dump every collection in the database to a timestamped folder under
 * `backend/backups/`, as JSON, one file per collection.
 *
 * Why this exists: MongoDB Atlas free and shared tiers have no automated
 * backups. Student records, enrolments and certificates are not reproducible —
 * a certificate is only worth something if the record behind it survives — and
 * every destructive operation this project has needed (deleting accounts,
 * replacing courses, a bad migration) had nothing to fall back on.
 *
 * JSON rather than `mongodump` on purpose: no external binary to install, and
 * the output is readable, so a single record can be recovered by hand in a
 * minute rather than by restoring a whole database.
 *
 * Usage:
 *   npm run db:backup
 *   npm run db:backup -- --out D:\wuteve-backups      (writable path off-machine)
 *
 * Restoring is deliberately NOT automated. A restore script that can be run
 * accidentally is a way to overwrite live data with an old copy. The folder
 * contains plain JSON; a single collection can be restored with mongoimport or
 * a short script, and a full restore should be a considered, manual decision.
 */

const fs = require('fs');
const path = require('path');

// Loaded the same way the server does: dotenv, from the backend root.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

function outputDir() {
  const flag = process.argv.indexOf('--out');
  if (flag !== -1 && process.argv[flag + 1]) {
    return path.resolve(process.argv[flag + 1], new Date().toISOString().replace(/[:.]/g, '-'));
  }
  return path.join(__dirname, '..', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Nothing to back up.');
    process.exit(1);
  }

  const target = outputDir();
  fs.mkdirSync(target, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const counts = {};
  let total = 0;

  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(target, name + '.json'), JSON.stringify(docs, null, 1), 'utf8');
    counts[name] = docs.length;
    total += docs.length;
  }

  fs.writeFileSync(
    path.join(target, '_manifest.json'),
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        database: db.databaseName,
        collections: counts,
        documents: total,
        note: 'Credentials and password hashes are included. Treat this folder as confidential and keep it off any synced or public drive.',
      },
      null,
      1
    ),
    'utf8'
  );

  await mongoose.disconnect();

  console.log('Backed up ' + total + ' documents across ' + names.length + ' collections');
  console.log('  ' + target);
  console.log('');
  names.forEach((name) => console.log('  ' + name.padEnd(24) + counts[name]));

  // The most likely failure after a backup is not taking the next one.
  const isLocal = !path.parse(target).root || target.startsWith(path.join(__dirname, '..', 'backups'));
  if (isLocal) {
    console.log('');
    console.log('This copy is on the same disk as the project. Copy it somewhere else');
    console.log('(external drive, cloud folder) - a backup beside its source is not a backup.');
  }
})().catch((error) => {
  console.error('Backup failed: ' + error.message);
  process.exit(1);
});
