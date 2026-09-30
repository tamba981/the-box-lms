#!/usr/bin/env node
'use strict';

/**
 * Generate the two signing secrets and print a block to paste into Railway.
 *
 *   npm run new-secrets
 *
 * Why this is a script and not a line in the documentation. The documented
 * one-liner is easy to get subtly wrong — run it once and use the same value for
 * both variables, or copy a value that is one character short and watch the
 * process refuse to boot with a message about length. Here the two are generated
 * separately, checked against the same rule the server enforces, and printed
 * together with the rest of the required variables.
 *
 * It writes nothing to disk and sends nothing anywhere. Copy the output into
 * Railway's variable editor, which accepts a pasted block of KEY=value lines.
 *
 * Do not paste the output into a chat, an issue or a screenshot. A signing key
 * that has been in a conversation is not a secret; anyone holding it can forge a
 * token for any account, including an administrator.
 */

const crypto = require('crypto');

/** The rule the server enforces before it will start in production. */
const MIN_LENGTH = 32;

function secret() {
  return crypto.randomBytes(48).toString('base64url');
}

const access = secret();
const refresh = secret();

if (access === refresh) {
  process.stderr.write('Generated identical secrets — this should be impossible. Re-run.\n');
  process.exit(1);
}

if (access.length < MIN_LENGTH || refresh.length < MIN_LENGTH) {
  process.stderr.write('Generated a secret shorter than the minimum — this should be impossible.\n');
  process.exit(1);
}

const line = '-'.repeat(72);

process.stdout.write(`
Paste the block below into Railway > your service > Variables.
Railway accepts a pasted block of KEY=value lines.

${line}
NODE_ENV=production
MONGODB_URI=
JWT_ACCESS_SECRET=${access}
JWT_REFRESH_SECRET=${refresh}
PUBLIC_BASE_URL=
LOG_LEVEL=info
${line}

Two values are deliberately left blank:

  MONGODB_URI       Your Atlas connection string, with the database name you
                    want production to use - \`wuteve\`, ideally, not the
                    \`wuteve_dev\` this machine uses. Rotate the password first
                    if it has ever been written down anywhere shared.

  PUBLIC_BASE_URL   Your Railway domain, for example
                    https://the-box-lms-production.up.railway.app - no trailing
                    slash. Deploy once to learn the hostname, then set this and
                    redeploy, or set it up front if you already know it.

Both are checked after you deploy:

  npm run verify:deploy -- https://your-app.up.railway.app

That command fails if PUBLIC_BASE_URL does not match the host it was given, which
is worth catching early: it is the link inside every verification and
password-reset email, and the address payments redirect to.

Optional, for paid courses and email - see docs/DEPLOYMENT.md:

  RESEND_API_KEY    Verification and reset emails cannot be delivered without it.
  EMAIL_FROM        Must be on a domain verified with Resend.
  STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
  ORANGE_MONEY_* / LONESTAR_MOMO_*

Note that setting the mobile money variables makes those methods selectable, not
payable: their charge calls are not implemented yet. See docs/PAYMENTS.md.

Do not paste this output anywhere other than Railway's variable editor.
`);
