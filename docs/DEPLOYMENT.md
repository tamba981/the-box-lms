# Deployment

Target: **Railway**, one service, running the API and serving the pages from the
same process.

---

## 1. Before you deploy

### Rotate everything that has been shared

The previous `backend/.env` on the developer machine held a live MongoDB Atlas
password, and both JWT secrets were the placeholder value that appears in the
source code. **A signing key that has been in a repository is not a secret.**
Anyone who knows it can forge a token for any account, including an
administrator.

Rotate, in this order:

1. **MongoDB Atlas** — Database Access → edit the user → *Edit Password*.
2. **JWT secrets** — generate fresh values:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Run it twice. The access and refresh secrets must be different.
3. **Stripe keys**, if you have ever pasted a live key anywhere.

### Separate the databases

Use a different database name for staging and production — `wuteve` for
production, `wuteve_staging` for staging — on the same cluster if you like. A
staging deploy that writes to production data is a data-loss incident waiting
for a tired evening.

---

## 2. Create the service

1. Railway → **New Project** → *Deploy from GitHub repo* → `the-box-lms`.
2. **Settings → Root Directory**: leave empty (the repository root).
3. Railway reads `railpack.json`:
   ```json
   {
     "build": { "commands": { "build": "cd backend && npm ci && npm run build" } },
     "deploy": { "startCommand": "cd backend && npm start" }
   }
   ```
   The build runs `scripts/check.js`, so a syntax error, a broken import or a
   missing dependency fails the deploy instead of producing a container that
   restarts forever.

---

## 3. Environment variables

Railway → **Variables**. Set these on the service, never in the repository.

### Required

| Variable             | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`           | `production`                                                             |
| `MONGODB_URI`        | `mongodb+srv://user:pass@cluster/wuteve?retryWrites=true&w=majority`      |
| `JWT_ACCESS_SECRET`  | A fresh 48-byte random string                                            |
| `JWT_REFRESH_SECRET` | A different fresh 48-byte random string                                  |
| `PUBLIC_BASE_URL`    | `https://your-domain.com` — no trailing slash                            |

`PUBLIC_BASE_URL` is not cosmetic: it is the link inside every verification and
password-reset email, and the address Stripe redirects to. If it is wrong, those
emails contain dead links.

### Optional

| Variable                | Effect when unset                                                |
| ----------------------- | ---------------------------------------------------------------- |
| `CORS_ORIGINS`          | Same-origin requests still work. List a host here only if a separate frontend origin needs to call the API |
| `RESEND_API_KEY`        | Verification and reset links are logged, not emailed             |
| `EMAIL_FROM`            | Uses a Resend sandbox sender                                     |
| `STRIPE_SECRET_KEY`     | Paid courses return a clear 503 on checkout; free courses work   |
| `STRIPE_WEBHOOK_SECRET` | **Webhooks rejected, so no payment would ever be fulfilled**     |
| `ORANGE_MONEY_*`        | Orange Money is shown as switched off, naming the absent values, and a charge is refused |
| `LONESTAR_MOMO_*`       | The same, for Lonestar Cell MTN MoMo                             |
| `LOG_LEVEL`             | Defaults to `info` in production                                 |

#### `CORS_ORIGINS` and the origin guard

Leaving `CORS_ORIGINS` unset is correct here. It is worth knowing why it used to
be fatal, because the failure was invisible to everything except a real browser.

Browsers send an `Origin` header on every `POST`, `PATCH` and `DELETE` —
**including same-origin ones**. The guard compared that header against the
configured allowlist alone, so with the allowlist empty every write from the
site's own pages was refused:

```
POST /api/v1/auth/login   Origin: https://your-domain.com   -> 403
POST /api/v1/auth/login   (no Origin, e.g. curl)            -> 200
```

Every `GET` kept working, so the deployment looked healthy: the health check
passed, pages loaded, and the failure appeared only when somebody tried to sign
in. The log even described the server's own origin as a blocked cross-origin
request, which is the opposite of what was happening.

The guard now also accepts an `Origin` that matches the host the request arrived
on, which is what "same-origin" actually means. Four checks in `npm run smoke`
pin this, because the suite is not a browser and never once sent the header that
triggered the bug.

If a write ever returns 403 `CROSS_ORIGIN_BLOCKED` on a healthy deployment, it is
this: the server is not recognising its own hostname, which normally means `Host`
or `X-Forwarded-Proto` is not reaching it as expected.

### Failing to start is intentional

With `NODE_ENV=production`, the process refuses to boot if a secret is missing,
still set to the source-code placeholder, or shorter than 32 characters. The log
line names the variable and prints the command to generate a replacement. This
is deliberate: the alternative is a server that accepts forged tokens.

---

## 4. MongoDB Atlas network access

Railway's outbound addresses are not fixed on every plan, so either:

- **Atlas → Network Access → Add IP Address → Allow access from anywhere**
  (`0.0.0.0/0`), and rely on the database credentials, or
- add Railway's static egress addresses, if your plan provides them.

The first option is a real trade-off, not a formality: with it, your only
defence is the password. Use a long generated password, and rotate it if it has
ever been written down somewhere shared.

---

## 5. Deploy, then verify

```bash
curl https://your-domain.com/health
```

```json
{ "status": "ok", "mongodb": "connected", "uptimeSeconds": 12, "version": "1.0.0" }
```

`status` is `degraded` and the HTTP code is `503` if the database is unreachable,
so a health check can be wired to an alert without parsing the body.

Then check by hand:

1. `https://your-domain.com/courses.html` — the catalog loads.
2. Register a new account. The confirmation link arrives (or is in the log if no
   email provider is configured).
3. `https://your-domain.com/nonexistent` — returns the 404 page **with a 404
   status**.
4. **Sign in.** This is the step that catches the origin trap described above: a
   browser sends an `Origin` header that `curl` does not, so this is the first
   place a same-origin guard bug becomes visible.
5. Open any page that writes — enrol in a free course, or post in the community —
   to prove `POST` works and not just `GET`.
6. Sign in as an admin and open `/admin-dashboard.html` — the guard lets you in;
   as a student it redirects you away.
7. `https://your-domain.com/verify/WGA-1999-999999` — reports not found rather
   than crashing.

### Populate real content

Do **not** run `npm run seed` against production — it creates accounts with
published passwords and refuses to run unless you force it. Create the first
administrator deliberately instead:

```javascript
// Run once, locally, with MONGODB_URI pointed at production.
require('bcryptjs').hash('a-password-you-choose', 12).then((hash) => {
  // Insert a user document with role: 'admin', emailVerified: true.
  console.log(hash);
});
```

Then sign in and create instructor accounts through the admin API, which is the
only place a role can be set.

---

## 6. Email

Set `RESEND_API_KEY` and `EMAIL_FROM`. `EMAIL_FROM` must be an address on a
domain you have verified with Resend, or delivery is refused.

Without a key the flows still work — the verification and reset links are
written to the server log with the full URL, which is enough to test but not to
run. **Password reset does not work for real users until this is set: they will
never see the link.**

---

## 7. Payments

### Read this before setting any payment variable

**Stripe does not accept businesses registered in Liberia.** Its own country list
carries Ghana, Nigeria, Kenya and South Africa and does not carry Liberia, Sierra
Leone or Guinea. An account needs a business entity and a bank account in a
supported country, so setting `STRIPE_SECRET_KEY` alone will not make cards work
for a Liberian business — and no key will.

The steps below are therefore correct but not sufficient. Cards need a gateway that
covers Liberia, or an entity in a supported country. The Stripe implementation is
kept because it is correct and tested, and because it is the reference the chosen
gateway should be modelled on. See `docs/PAYMENTS.md` for the options and the
questions to put to a prospective provider.

**The mobile money providers cannot take money yet either.** Orange Money and
Lonestar Cell MTN MoMo are wired end to end — provider registry, phone
normalisation, signed callbacks, and settlement shared with the card path — but the
two calls that actually contact each provider are deliberate stubs. They throw
rather than guess, because inventing an endpoint shape or an authentication scheme
would produce something that looks finished and fails against real money. Supplying
their credentials makes a method *selectable*, not *payable*. What is missing, and
what to request from each provider, is listed in `docs/PAYMENTS.md`.

Until one of those is resolved, the honest state of this deployment is: **free
courses work, and paid courses tell the student plainly that no payment method is
available and that nothing has been charged.**

### Stripe

1. Set `STRIPE_SECRET_KEY`.
2. Dashboard → Developers → **Webhooks** → *Add endpoint*:
   `https://your-domain.com/api/v1/payments/webhook`
3. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `payment_intent.payment_failed`.
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Without the webhook secret, every webhook is rejected with a 400 and **no
payment is ever fulfilled**. Enrollment is granted only from a signed webhook —
never from the browser redirect, which can be abandoned or forged.

Fulfilment is idempotent: Stripe retries, the customer double-clicks Pay, and a
webhook is delivered twice are all safe. A payment record is unique per
(student, course), and enroling twice returns the existing enrollment.

**Test in Stripe test mode first.** The checkout and webhook paths in this
codebase have never been exercised against live Stripe.

---

## 8. Custom domain

Railway → **Settings → Networking → Custom Domain**, then set the CNAME at your
DNS provider.

Afterwards set `PUBLIC_BASE_URL` to the new domain and redeploy. Links already
sent in old emails will still point at the Railway hostname — that is expected
and harmless; the Railway hostname keeps working.

---

## 9. Ongoing

- `npm run build` and `npm run smoke` before every deploy. Do not deploy on a
  red smoke run.
- Rotate the JWT secrets if one is ever pasted into a chat, a screenshot or a
  ticket. Rotating signs everybody out, which is the correct response.
- The `Token` collection is TTL-indexed; expired tokens remove themselves. No
  cleanup job is needed.
- Back up Atlas. There is no export path in this codebase, and nothing here
  writes a backup for you.
