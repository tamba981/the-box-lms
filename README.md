# Wuteve Global Academy

A learning platform: course catalog, enrolment, lessons, progress, certificates, instructor authoring, an admin area, discussions, messaging, live sessions and optional card payments — served by a single Node process.

---

## Why it looks like this

The project began as a set of six self-contained HTML pages with a small Express
authentication stub. The pages were good; almost nothing behind them was real.

What changed:

- The API was rebuilt from three working endpoints to a complete domain API.
- The privilege-escalation hole in registration was closed (see *Security*).
- The three dashboards, which rendered hardcoded mock data, are being moved onto
  live data (see *Current status* — this is the main outstanding item).
- The deployment configuration was fixed; it could not have deployed as it was.
- The front end gained one shared API client instead of five copies of a
  hardcoded hostname.

---

## Architecture

One Node process serves both the JSON API and the static pages. There is no
separate front-end build step, and nothing to deploy twice.

```
wuteve-global-academy/
├── backend/                     Express API + static file serving
│   ├── server.js                entry point: config → database → listen
│   ├── src/
│   │   ├── app.js               middleware order and route mounting
│   │   ├── config/env.js        validated configuration, fails fast
│   │   ├── db.js                Mongoose connection lifecycle
│   │   ├── models/              15 schemas
│   │   ├── routes/              auth, courses, enrollments, certificates,
│   │   │                        notifications, community, messages,
│   │   │                        study-groups, live-sessions, admin,
│   │   │                        payments, dashboard
│   │   ├── services/            token, certificate, enrollment, payment,
│   │   │                        notification, email
│   │   ├── middleware/          auth, validation, errors, security, limits
│   │   ├── validators/          Zod schemas for every request
│   │   └── lib/                 errors, permissions, pagination, logging
│   └── scripts/                 check (build gate), seed, smoke, init-env
└── frontend/public/             the pages, plus shared assets
    └── assets/
        ├── css/wga-shell.css    shared design tokens
        └── js/wga-api.js        the only place the front end calls the API
            js/wga-ui.js         formatting, escaping, forms, toasts
```

**Design rules worth keeping:**

- Only route and service modules touch the database. No page code, no
  middleware.
- Every request body, query string and route parameter is parsed by a Zod
  schema before it reaches a query. This is the injection defence.
- Access decisions go through `lib/permissions.js`. A rule should be got wrong
  in one place, not twelve.
- Money is an integer number of minor units (`priceCents`). There are no floats
  anywhere in the money path.
- The server formats money (`priceLabel`) so two pages cannot disagree.

---

## Quick start

```bash
cd backend
npm install
npm run env:init      # creates .env with strong random secrets
```

Then set `MONGODB_URI` in `backend/.env`:

```
mongodb://127.0.0.1:27017/wuteve        # local server
mongodb+srv://user:pass@cluster/wuteve  # MongoDB Atlas
```

```bash
npm run seed          # demo accounts, 5 courses, a live session
npm start             # http://localhost:5000
```

Demo sign-in. The seed creates these accounts, all with one password:

| Account                 | Role       |
| ----------------------- | ---------- |
| `admin@wuteve.edu`      | admin      |
| `instructor@wuteve.edu` | instructor |
| `student@wuteve.edu`    | student    |

The password is deliberately not printed here. The seed defaults to a well-known
string that lives in `backend/scripts/seed.js`, so anything that can read this
repository can sign in as an administrator wherever that default is still in
place. Set your own before the database is reachable:

```bash
SEED_PASSWORD='…' npm run seed
```

Two things worth knowing:

- The seed only assigns a password when it **creates** an account. For one that
  already exists it updates the profile and leaves the password alone — so
  re-seeding neither restores a known password nor undoes a change you made.
- Change one afterwards with `POST /api/v1/auth/change-password`. That also
  invalidates every token issued before the change; writing the password field
  directly would not, and existing sessions would stay signed in.

`npm run seed -- --fresh` replaces the demo content.

---

## Scripts

Inside `backend/`:

| Command                   | What it does                                                            |
| ------------------------- | ----------------------------------------------------------------------- |
| `npm start`               | Run the server                                                          |
| `npm run dev`             | Run with `--watch`                                                      |
| `npm run build`           | **The build gate.** Parses every file and every page's inline script, resolves every import, checks dependencies |
| `npm run verify`          | The build gate, then the end-to-end suite — the whole gate in one command |
| `npm test`                | The end-to-end suite alone (190 checks against a real database)         |
| `npm run smoke`           | The same suite, under its older name                                    |
| `npm run verify:deploy`   | Check a deployed instance from outside it — pass it a URL               |
| `npm run check:mongo-uri` | Test a connection string without ever printing it           |
| `npm run db:inspect`      | Report what is in the database this configuration points at, and compare databases |
| `npm run new-secrets`     | Print a fresh variable block to paste into Railway                      |
| `npm run env:init`        | Create or repair `.env`; preserves values it does not manage            |
| `npm run seed`            | Create demo content                                                     |

`npm run build` is what the deploy runs. It does not execute application code,
so it needs no database and no secrets — it fails fast on a syntax error, a
mistyped import, a missing dependency or a missing page. It also parses the
inline `<script>` in every page and checks each `<style>` block's braces, because
most of this product's front-end logic lives in those blocks and a truncated paste
there produces a page that renders and then does nothing.

`npm test` boots the real app and exercises registration, sign-in, refresh
rotation, password reset, the full learning loop (instructor writes a course →
admin approves → student enrols → completes → certificate issued → verified
publicly), community, messaging, live sessions, input validation, email templates,
money formatting, the admin reports, the Stripe webhook path, the mobile money
path, and the same-origin guard. It cleans up after itself. Run it before every
deploy — `npm run verify` does it for you.

---

## Configuration

All settings live in `backend/.env`. See `.env.example` for the annotated list.

**Required** — the process refuses to start in production without them:

| Variable             | Notes                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `MONGODB_URI`        | Connection string                                                        |
| `JWT_ACCESS_SECRET`  | ≥32 chars, random, unique. Not the placeholder in the source             |
| `JWT_REFRESH_SECRET` | ≥32 chars, random, different from the access secret                      |
| `PUBLIC_BASE_URL`    | The address users actually reach. Used in email links and Stripe redirects |

**Optional** — the features degrade cleanly without them:

| Variable                | Without it                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| `CORS_ORIGINS`          | Only same-origin browser requests are accepted                    |
| `RESEND_API_KEY`        | Verification and reset links are written to the server log instead |
| `EMAIL_FROM`            | Falls back to a Resend sandbox sender                             |
| `STRIPE_SECRET_KEY`     | Paid courses cannot be bought; checkout returns a clear 503       |
| `STRIPE_WEBHOOK_SECRET` | Webhooks are rejected — payments would never be fulfilled         |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## API

Base path `/api/v1`. All responses use `{ success, message, data }`.

| Area           | Endpoints                                                                   |
| -------------- | --------------------------------------------------------------------------- |
| Auth           | `register`, `login`, `refresh`, `logout`, `me`, `change-password`, `forgot-password`, `reset-password`, `verify-email`, `resend-verification`, `sessions` |
| Courses        | catalog, `categories`, `mine`, detail, create, update, archive, `publish`, `unpublish`, `roster` |
| Lessons        | list, detail, create, update, delete, `complete`                            |
| Enrollments    | `me`, one course, leave, enrol                                            |
| Certificates   | `me`, one, **public verification**                                           |
| Notifications  | list, `read`, `read-all`, delete                                            |
| Community      | posts, one post with replies, replies, `like`, `activity`                    |
| Messages       | threads, one thread, send, `read`, `unread-count`                            |
| Study groups   | list, create, one, `join`, `leave`, delete                                   |
| Live sessions  | list, `upcoming`, one, create, update, `attend`, cancel                      |
| Dashboard      | `student`, `instructor`, `activity`                                          |
| Admin          | `stats`, users, create user, one user, update, courses, `approve`, `reject`, enrolments, `announcements`, certificate revoke |
| Payments       | `config`, `checkout/:courseId`, `webhook`, `me`, admin list, refund          |

Two endpoints are deliberately public: the course catalog and certificate
verification. Verification exposes only what is printed on the certificate — a
name, a course title and a date. No email, no account id.

---

## Pages

| Page                    | Status                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `index.html`            | Landing page. Auth wired to the live API; course cards still static |
| `login.html`            | Live. Sign-in, registration, `?next=` return, reset/session notices |
| `courses.html`          | Live. Full catalog with search, filters, sorting, pagination        |
| `course.html`           | Live. Detail, syllabus with locked/preview, enrolment              |
| `forgot-password.html`  | Live                                                                |
| `reset-password.html`   | Live                                                                |
| `verify-email.html`     | Live                                                                |
| `certificate.html`      | Live. Public verification at `/verify/<code>`                       |
| `student-dashboard.html`| **Live.** Statistics, courses, progress, lessons, live sessions, discussions, messages, certificates and profile all come from the API |
| `instructor-dashboard.html` | **Mock data.** Role-guarded, but the contents are hardcoded                |
| `admin-dashboard.html`  | **Mock data.** Role-guarded, but the contents are hardcoded                |
| `404.html`              | Live, served with a real 404 status                                |

---

## Current status

**Complete and verified**

- Authentication: registration, sign-in, rotating refresh tokens with replay
  detection, sign-out (one device or all), password change, password reset,
  email verification, session listing.
- Course catalog and detail, with enrolment gating that actually holds.
- The learning loop: enrol → read lessons → complete → progress → certificate.
- Certificate issuing (idempotent) and public verification by serial or code.
- Instructor authoring: courses, lessons, ordering, roster.
- Admin: statistics, user and role management, course moderation, manual
  enrolment, announcements, certificate revocation.
- Community, direct messaging, study groups, live sessions.
- Notifications in-app, with email delivery when a provider is configured.
- Stripe checkout and webhook fulfilment, disabled cleanly without keys.
- A payment method registry reporting honestly what is usable: card, Orange Money
  and Lonestar Cell MTN MoMo, each enabled by configuration, each naming the
  settings it is missing. The course page renders that list, shows unavailable
  methods disabled with the reason, and offers no button at all when nothing is
  configured. See `docs/PAYMENTS.md`.
- Security: role escalation closed, secrets validated, rate limiting, security
  headers, CORS allowlist, Zod validation on every input.

**Outstanding**

1. **The mobile money charge calls are not implemented.** The provider registry,
   phone normalisation, signed callbacks and shared settlement are all in place
   and tested, but the two calls that contact Orange Money and Lonestar Cell MTN
   throw rather than guess at an API shape. Supplying credentials makes a method
   *selectable*, not *payable*.
2. **Cards cannot serve a Liberian business.** Stripe's own country list does not
   include Liberia, so the implemented Stripe path cannot be used as it stands.
   A gateway that covers Liberia has to be chosen first.
3. **Refunds do not move money.** `POST /payments/:id/refund` marks the payment
   refunded and cancels the enrolment without calling any provider. The admin
   button reads "Mark refunded" and warns that the refund must be issued in the
   provider's dashboard.
4. **Streaming lesson video** is a URL field. There is no upload or transcoding.
5. **Certificate PDFs.** Certificates are records with a public verification
   page; `pdfUrl` is a field you can populate, not a generator.
6. **`'unsafe-inline'` in the Content Security Policy.** Every page carries its
   own inline `<script>`, so it cannot be removed without moving those blocks
   into `/assets/js` files. The directive is documented in
   `src/middleware/security.js`.

**Claims that were not true, and were removed**

The footer of `index.html` presented Stanford, MIT, Google, Microsoft, Amazon, IBM,
Harvard and Yale as institutions that trust the academy. There was no relationship
with any of them. The page also advertised "blockchain-verified" certificates and
showed counters such as 12,847 learners and 500+ courses. Certificate verification
is real, but it is a database record checked by a signature code, not a blockchain.

All of it is gone: the logo wall removed, the certificate wording now describing
the actual mechanism, and the counters read from the catalogue.

The last of it was hiding in the pre-JavaScript fallback markup, which is worth
recording because it survived two rounds of this cleanup. Two blocks of six
fully-written cards stood in `index.html`, inventing six courses, six instructors
and six learner counts, with "Join Now" links pointing at `#`. They were replaced
once the catalogue arrived, so they were only ever meant to be a placeholder — but
this server serves the pages and the API from one process, so that fetch is not
instant, and the failure path did not clear them at all. If the API was
unreachable, the page showed invented courses and invented enrolment numbers
directly beside the line saying the catalogue could not be loaded.

Both blocks are now neutral skeleton blocks that make no claim, and the failure
path clears the trending grid as well as the course grid. The only course names in
that file now come from the template that renders real ones, and the only
remaining occurrence of "12,847" is the comment recording that it used to be there.

---

## Defects found while verifying

Found by driving a real browser rather than by the test suite, which is worth
recording because the tests did not catch them:

| Defect | How it showed up |
| ------ | ---------------- |
| `GET /messages/threads` returned 500 | `schemas.pagination` was a plain object where a Zod schema belonged, so `validate()` threw `parse is not a function`. Every test missed it: the auth test only proved the route returns 401 without a token, and the messaging tests used other paths. There is now a sweep that asserts "not a server error" across 29 authenticated routes. |
| No email was ever addressed to anyone | Every template returned a subject and a body but no `to`, so the transport logged `To: undefined`. With a provider configured, verification links, password resets, enrolment confirmations and certificates would all have gone nowhere — while every request still returned 200. There is now a check per template. |
| The whole site was blocked by its own CSP | Every page here is inline `<script>` plus ~97 inline `onclick=` handlers. Helmet's *default* policy is `script-src 'self'` and `script-src-attr 'none'`, which blocks all of it. |
| Signing out did not end the session | The dashboards cleared `localStorage` and navigated away while the refresh token stayed valid on the server. |
| `GET /courses/:slug` returned 500 | A query projection omitted `resources`, and the lesson serialiser read `.length` off `undefined`. |
| A production deploy could not accept a single write | The same-origin guard compared the `Origin` header only against the configured allowlist. Browsers send `Origin` on every `POST`, including same-origin ones, so with `CORS_ORIGINS` unset — the default — every write from the site's own pages returned 403 while every `GET` kept working. The log described the server's own origin as a blocked cross-origin request. Nothing caught it because the smoke suite is not a browser and never sent the header. Four checks now pin it. |
| `npm test` had never run | The script pointed at `tests/`, which has never existed anywhere in this repository's history. It now runs the suite that does exist. |
| `npm run env:init` did not exist | The README documented it twice as the first step of the quick start, and `scripts/init-env.js` was there and working. Nothing had wired it up, so following the instructions failed at step one. |
| `env:init` deleted credentials it did not recognise | Once wired up, it regenerated `.env` from a fixed template, so any key the template had not been taught about was silently removed. It would have done that to the mobile money keys on their first run. Unknown keys are now preserved and reported. |

---

## Security

What was wrong when this work started, and what it is now:

| Issue | Before | Now |
| ----- | ------ | --- |
| Privilege escalation | `POST /auth/register` accepted `role` from the body, so anyone could create an admin | Role is assigned server-side and Zod strips the field |
| Signing key | The JWT secret was the placeholder from the source code, which is public | Validated at boot; production refuses to start with a placeholder |
| Refresh tokens | The refresh token was the same string as the access token | Separate opaque tokens, hashed at rest, rotated on use, replay detection revokes the family |
| Brute force | No rate limiting | Per-IP limits on sign-in, per-IP-and-email limits on reset and verification |
| Input validation | None; values passed to Mongoose unchecked | Zod schema on every body, query and param |
| CORS | `origin: true` — reflected any origin | Explicit allowlist, plus the request's own host, so a same-origin write works without configuration |
| Suspension | A suspended user kept working until their token expired | Status and role read from the database on every request |
| Security headers | None | Helmet, with a documented CSP |
| Database startup | Server reported healthy with no database | Connect before listen; the process exits if it cannot |
| Deploy build | `npm run build` did not exist, so every deploy failed | A real build gate that validates the tree |

**Known limitations, stated plainly:**

- Tokens are held in `localStorage`, so a successful XSS could read them. Moving
  the refresh token to an `httpOnly` cookie is the correct fix and is not done.
- `'unsafe-inline'` is in the CSP, for the reason above.
- The `backend/.env` on the original developer machine contained a live Atlas
  password. It was never committed, but **rotate it**, and rotate the JWT
  secrets before going live.
- Payments are implemented but unexercised: no live Stripe key has been used
  against this code, so the checkout and webhook paths have only been verified
  for their failure modes. Stripe also cannot serve a Liberian business, and the
  mobile money charge calls are stubs. See `docs/PAYMENTS.md`.

---

## Renaming from the old name

This project was called **The Box** and is now **Wuteve Global Academy**. Several
identifiers still carry the old name, because each of them lives in another system
and is changed there rather than here. They are listed so that nothing in this
repository is quietly false:

| Where | Current value | How to change it |
| --- | --- | --- |
| Database user (Atlas) | `theboxedulr_db_user` | Atlas → **Database Access** → add a new user, point `MONGODB_URI` at it, then delete the old one. A username cannot be edited in place. |
| Database | `thebox_lms` | Nothing to rename: `wuteve_dev` already exists and holds the content. Just name it in `MONGODB_URI`. `npm run db:inspect` shows what each one contains. |
| Railway service and domain | `the-box-lms-production.up.railway.app` | Railway → **Settings**. Renaming the service changes the domain, so update `PUBLIC_BASE_URL` in the same pass and redeploy. |
| GitHub repository | `tamba981/the-box-lms` | GitHub → **Settings → Rename**. GitHub redirects the old URL, so existing clones keep working. |
| Local folder | `THE BOX WEBSITE` | Rename it when nothing has it open — the editor, the terminals and the absolute paths in any running session all point at the current name. |

Two references are deliberately left as they are:

- `backend/scripts/check.js` holds `RETIRED_HOST = 'the-box-lms-production.up.railway.app'`
  as a guard, so that no page may hard-code that hostname again. It names a
  specific host to avoid rather than a brand, and it still needs to say what it says.
- `docs/SECURITY-INCIDENT.md` records what happened at the time, so it uses the
  names that existed when it happened.

---

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). In short: one Railway service,
root directory the repository root, with `MONGODB_URI`, the two JWT secrets and
`PUBLIC_BASE_URL` set as variables.

Two commands do the parts that are easy to get wrong:

```bash
npm run new-secrets                      # in backend/ — prints a variable block to paste into Railway
npm run verify:deploy -- https://your-domain.com   # after deploying
```

The second one fails if a same-origin write is refused, which is the failure that
would otherwise take the whole site down while every health check still passed.
