#!/usr/bin/env node
'use strict';

/**
 * Rotate the password on each demo/seeded account.
 *
 *   node scripts/rotate-passwords.js <current-password-file> <new-password-file> [email ...]
 *
 * Why the passwords come from files rather than a flag:
 *
 *   - A value passed as an argument is visible to anything that can list
 *     processes, and lands in your shell history.
 *   - A value pasted into a chat or an issue is not a secret any more. The whole
 *     point of this exercise is that the current password was exposed that way.
 *
 * So: write each password to a file, pass the paths, delete the files after.
 *
 *   Set-Content -NoNewline -Path "$env:TEMP\old.txt" -Value '<current>'
 *   Set-Content -NoNewline -Path "$env:TEMP\new.txt" -Value '<new>'
 *   node scripts/rotate-passwords.js "$env:TEMP\old.txt" "$env:TEMP\new.txt"
 *   Remove-Item "$env:TEMP\old.txt","$env:TEMP\new.txt"
 *
 * This goes through POST /auth/change-password on purpose. Writing the field
 * directly and letting the model's pre-save hook hash it would look like it
 * worked and would leave `passwordChangedAt` untouched — which means every access
 * token already issued stays valid. The route is the only path that sets it, and
 * it also revokes all sessions.
 *
 * The route refuses to set a password equal to the current one, so rotating to
 * the value that is already in use fails by design rather than silently no-opping.
 */

const fs = require('fs');

const BASE = process.env.API_BASE || 'http://localhost:5000/api/v1';
const DEFAULT_ACCOUNTS = ['admin@wuteve.edu', 'instructor@wuteve.edu', 'student@wuteve.edu'];

function readPassword(path, label) {
  if (!fs.existsSync(path)) {
    console.error(`No ${label} password file at ${path}`);
    process.exit(1);
  }
  const value = fs.readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  if (!value) {
    console.error(`The ${label} password file is empty.`);
    process.exit(1);
  }
  return value;
}

/* The same rule the API enforces, so a bad choice fails here with a clear
   message instead of a 400 partway through the list. */
function complainAbout(weak) {
  const problems = [];
  if (weak.length < 8) problems.push('shorter than 8 characters');
  if (weak.length > 72) problems.push('longer than 72 characters');
  if (!/[A-Za-z]/.test(weak)) problems.push('contains no letter');
  if (!/[0-9]/.test(weak)) problems.push('contains no number');
  return problems;
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
    /* a body is not guaranteed */
  }
  return { status: res.status, payload };
}

async function main() {
  const [, , currentPath, newPath, ...extra] = process.argv;

  if (!currentPath || !newPath) {
    console.error('usage: node scripts/rotate-passwords.js <current-password-file> <new-password-file> [email ...]');
    process.exit(1);
  }

  const current = readPassword(currentPath, 'current');
  const next = readPassword(newPath, 'new');

  if (current === next) {
    console.error('The new password is the same as the current one. The API rejects that, and it would defeat the point.');
    process.exit(1);
  }

  const problems = complainAbout(next);
  if (problems.length) {
    console.error('The new password is: ' + problems.join(', ') + '.');
    console.error('Required: 8-72 characters, at least one letter and one number.');
    process.exit(1);
  }

  const accounts = extra.length ? extra : DEFAULT_ACCOUNTS;
  console.log(`Rotating ${accounts.length} account(s) via ${BASE}\n`);

  const results = [];

  for (const email of accounts) {
    const login = await post('/auth/login', { email, password: current });

    if (login.status !== 200 || !login.payload || !login.payload.data) {
      const code = (login.payload && (login.payload.code || login.payload.message)) || login.status;
      console.log(`  FAIL  ${email} — could not sign in with the current password (${code})`);
      results.push({ email, ok: false });
      continue;
    }

    const token = login.payload.data.accessToken || login.payload.data.token;
    if (!token) {
      console.log(`  FAIL  ${email} — sign-in returned no token`);
      results.push({ email, ok: false });
      continue;
    }

    const change = await post('/auth/change-password', { currentPassword: current, newPassword: next }, token);

    if (change.status === 200) {
      console.log(`  OK    ${email} — password changed, all sessions revoked`);
      results.push({ email, ok: true });
      continue;
    }

    const detail = change.payload && change.payload.details && change.payload.details.length
      ? change.payload.details[0].message
      : (change.payload && change.payload.message) || change.status;
    console.log(`  FAIL  ${email} — ${detail}`);
    results.push({ email, ok: false });
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} rotated.`);

  if (failed.length) {
    console.log('Failed: ' + failed.map((f) => f.email).join(', '));
    console.log('Nothing is left half-changed: each change either completed or did not happen.');
    process.exit(1);
  }

  console.log('Delete the password files you created, and the values they held.');
  console.log('A "password changed" email is attempted for each account; without RESEND_API_KEY');
  console.log('and a verified sending domain that send will fail, which does not affect the change.');
}

main().catch((error) => {
  console.error('Unexpected failure: ' + error.message);
  process.exit(1);
});
