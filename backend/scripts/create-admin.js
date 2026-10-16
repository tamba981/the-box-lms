'use strict';

/**
 * Create an administrator, or reset one's password.
 *
 *   node scripts/create-admin.js someone@example.com
 *   node scripts/create-admin.js someone@example.com --name "Amina Kamara"
 *   node scripts/create-admin.js someone@example.com --out D:\secrets
 *
 * Why this exists: the administrator account is on `wuteve.edu`, which is not a
 * domain the academy controls, so the "forgot password" link cannot reach
 * anybody. With no transactional email configured either, there is no
 * self-service route back into the dashboard at all. This is that route.
 *
 * The password is written to a file and **never printed**. A password echoed to
 * a terminal ends up in scrollback, in a screenshot, and in whatever is
 * capturing the session — which is the whole reason the account was rotated
 * away from a published default in the first place. The path is printed; the
 * value is not.
 *
 * Assigning a new password also stamps `passwordChangedAt`, which the auth
 * middleware compares against a token's issue time. Every session that existed
 * before this run stops working, which is the point of a reset.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const User = require('../src/models/User');
const config = require('../src/config/env');
const { generatePassword } = require('../src/lib/generatePassword');

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--name' || token === '--out') {
      flags[token.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(token);
    }
  }

  return { email: positional[0], flags };
}

/** A filename that cannot escape the directory it is written into. */
function fileNameFor(email) {
  return `admin-${String(email).replace(/[^a-z0-9.@-]/gi, '_')}.txt`;
}

/**
 * Which database was written to, without the credentials.
 *
 * Worth printing rather than assuming: the local `.env` and the deployed
 * environment each name their own `MONGODB_URI`, and if they point at different
 * clusters then creating an account here does nothing for the live site. The
 * host identifies the cluster; the user, password and query string are dropped.
 */
function describeDatabase() {
  try {
    const url = new URL(config.mongoUri);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.host}/${database}`;
  } catch (_) {
    return '(could not be parsed)';
  }
}

function resolveOutDir(requested) {
  if (requested) return path.resolve(requested);

  const home = os.homedir();
  const candidates = [
    path.join(home, 'Documents'),
    // Documents is frequently redirected into OneDrive on Windows.
    path.join(home, 'OneDrive', 'Documents'),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return path.join(existing || home, 'WUTEVE-Credentials');
}

async function main() {
  const { email: rawEmail, flags } = parseArgs(process.argv.slice(2));

  if (!rawEmail) {
    console.error('Usage: node scripts/create-admin.js <email> [--name "First Last"] [--out <dir>]');
    process.exit(1);
  }

  const email = String(rawEmail).trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`"${rawEmail}" does not look like an email address.`);
    process.exit(1);
  }

  const name = String(flags.name || 'Academy Administrator').trim();
  const parts = name.split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || 'Admin';

  await db.connect();

  const password = generatePassword();

  const existing = await User.findOne({ email }).select('+password');
  const wasAdmin = existing ? existing.role === 'admin' : false;

  let user;
  let created;

  if (existing) {
    const previousRole = existing.role;

    existing.role = 'admin';
    existing.status = 'active';
    existing.emailVerified = true;
    existing.emailVerifiedAt = existing.emailVerifiedAt || new Date();
    existing.password = password;
    existing.passwordChangedAt = new Date();

    await existing.save();

    user = existing;
    created = false;

    if (previousRole !== 'admin') {
      console.log(`  note: ${email} was a ${previousRole} and has been promoted to admin.`);
    }
  } else {
    user = await User.create({
      firstName,
      lastName,
      email,
      role: 'admin',
      password,
      status: 'active',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      passwordChangedAt: new Date(),
    });

    created = true;
  }

  /**
   * Prove the password works before writing it down.
   *
   * The value is compared here and the result printed, so a hashing mistake is
   * caught in this run rather than by the person who cannot sign in. Nothing
   * about the comparison reveals the password.
   */
  const reloaded = await User.findById(user._id).select('+password');
  const passwordWorks = await reloaded.comparePassword(password);

  const outDir = resolveOutDir(flags.out);
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, fileNameFor(email));

  fs.writeFileSync(
    outFile,
    [
      'Wuteve Global Academy — administrator credentials',
      '',
      `Created   : ${new Date().toISOString()}`,
      `Account   : ${email}`,
      `Role      : admin`,
      `Database  : ${config.env}`,
      `Dashboard : ${config.publicBaseUrl}/admin-dashboard.html`,
      `Sign in   : ${config.publicBaseUrl}/login.html`,
      '',
      `Password  : ${password}`,
      '',
      'Store this in a password manager, then delete this file.',
      'Assigning a new password retires every existing session for this account.',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  console.log('');
  console.log('  ' + (created ? 'created' : 'updated') + ' : ' + email);
  console.log('  role      : admin' + (wasAdmin ? ' (already an admin)' : ''));
  console.log('  password  : written to file, not printed here');
  console.log('  verified  : ' + (passwordWorks ? 'the stored hash matches the generated password' : 'FAILED'));
  console.log('  database  : ' + describeDatabase());
  console.log('  file      : ' + outFile);
  console.log('');
  console.log('  Read it with:');
  console.log(`    Get-Content "${outFile}"`);
  console.log('');
  console.log('  Sessions issued before this run no longer work.');

  await db.disconnect();
  process.exit(passwordWorks ? 0 : 1);
}

main().catch(async (error) => {
  console.error('FAILED: ' + error.message);
  try {
    await db.disconnect();
  } catch (_) {
    /* the connection may never have opened */
  }
  process.exit(1);
});
