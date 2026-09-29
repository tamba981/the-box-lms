# Security incident: credentials committed to a public repository

**Status:** resolved. The exposed credential has been rotated, and the old one is confirmed
rejected by the cluster.
**Date of discovery:** 2026-09-29
**Exposure window:** 2026-07-03 to 2026-09-29 (approximately 12 weeks)
**Password rotated and verified:** 2026-09-29

## What happened

Commit `054c489` ("Add environment variables for backend configuration") added the
file `backend/.env` to this repository. That commit was pushed to `origin`, and
`origin` is a **public** GitHub repository, so the file was readable by anyone on
the internet for roughly twelve weeks.

The file contained:

| Variable | What it was |
|---|---|
| `MONGODB_URI` | A working MongoDB Atlas connection string, including the password for the database user `theboxedulr_db_user`. The URI named the database `thebox_lms`. |
| `JWT_ACCESS_SECRET` | The placeholder value `your-super-secret-key-min-32-chars-long`. |
| `PORT` | Not sensitive. |

The database password was **still in use** at the time of discovery, so the
exposure was live rather than historical. The same Atlas user remains in use for
local development against `wuteve_dev`.

## Impact

- **High — database.** Anyone who read that repository held read/write credentials
  for the Atlas cluster. The data in `thebox_lms` (and anything else that
  database user could reach) must be treated as potentially read or modified by a
  third party.
- **Low — token signing.** The exposed `JWT_ACCESS_SECRET` was the placeholder,
  not a real secret. It is also not sufficient on its own to impersonate anyone:
  `src/middleware/auth.js` loads the authoritative role from the database on every
  request and never trusts the role carried in the token, so a forged token would
  still need a real active account id. `env.js` refuses to start in production
  when a placeholder secret is configured, so a production deployment could not
  have been running with it.
- **None — third-party services.** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  and `RESEND_API_KEY` were all empty in the committed file and remain
  unconfigured.

## What has been done

1. `.gitignore` previously listed `.env`, `.env.local`, `.env.production` and
   `.env.*.local` — none of which matched `.env.backup`, and none of which matched
   the committed `.env` at the time it was committed. It now ignores `.env` and
   `.env.*` and re-admits only `.env.example`.
2. `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` were replaced with fresh 48-byte
   random values. All existing sessions are invalid as a result.
3. The full history was searched for other copies of the credentials. The string
   appears in exactly one place: `054c489:backend/.env`. Every other occurrence of
   a `mongodb+srv://` URI in the repository is a placeholder in
   `README.md`, `docs/DEPLOYMENT.md` and `scripts/init-env.js`.
4. The Atlas password for `theboxedulr_db_user` was rotated, and the rotation was
   verified rather than assumed: connecting with the credentials currently in
   `backend/.env` succeeds, while connecting with the credentials that were
   published is refused with an authentication error. The configured database
   name (`wuteve_dev`) was preserved through the change.
5. The build gate and the 166-check smoke suite pass against the cluster with the
   new credentials.
6. The published commit was removed from `origin/main` by force-push, and a local
   ref (`backup/origin-main-pre-purge`) retains the previous remote state.

   This step is **not** a security control, and it is recorded here so nobody later
   mistakes it for one. GitHub continued to serve the removed commit after the
   force-push — the commit page, the blob page, and `raw.githubusercontent.com` all
   returned the file, with no authentication. Removing a commit from a branch does
   not remove it from the service. Only the password rotation made those URLs
   worthless.

## What remains

### 1. Rotate the Atlas database password — done

The password has been rotated and the old one verified as rejected. The steps,
kept for the next person who has to do this:

1. Atlas → **Database Access** → user `theboxedulr_db_user` → **Edit** →
   **Autogenerate** a new password.
2. Review that user's privileges. It should have read/write on the application's
   databases and nothing else, and should not hold any Atlas administrative role.
3. Atlas → **Network Access**. If any entry is `0.0.0.0/0`, restrict it.
4. Review the cluster for activity that is not yours — unexpected collections,
   documents, database users or API keys. Assume the data was readable during the
   exposure window.

**Still outstanding from this step:** the review of the cluster's privileges,
network access and contents. Rotation stops the credential working; it does not
tell you whether anyone used it. The exposure window was about twelve weeks, so
that review is worth doing properly rather than skipping.

### 2. Purge the commit from the remote — done, with a caveat

Done by force-push. Note again that it changed nothing about the exposure:
GitHub kept serving the commit, including over `raw.githubusercontent.com`. It is
still worth asking GitHub Support to remove the cached views if you want the file
gone from the web interface, but understand that anyone who fetched it in the
preceding twelve weeks already has a copy. Rotation is the only real remedy, and
it has been applied.

### 3. Decide whether the repository should stay public

`tamba981/the-box-lms` is public and contains this project's source. If that is
deliberate, keep it public and rely on rotation plus the ignore rules above. If it
was not, make it private.

### 4. Delete `backend/.env.backup`

It is a second plaintext copy of the same credentials. It is ignored by git, but
after the password is rotated it will hold a stale, useless secret. Deleting it is
safer than keeping it.
