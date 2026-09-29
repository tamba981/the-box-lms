# Security incident: credentials committed to a public repository

**Status:** contained except for one step that only the repository owner can perform.
**Date of discovery:** 2026-09-29
**Exposure window:** 2026-07-03 to 2026-09-29 (approximately 12 weeks)

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
4. The build gate and the 166-check smoke suite pass with the rotated secrets.

## What remains

### 1. Rotate the Atlas database password — required

This is the only step that actually ends the exposure, and it can only be done
from the Atlas console:

1. Atlas → **Database Access** → user `theboxedulr_db_user` → **Edit** →
   **Autogenerate** a new password.
2. Review that user's privileges. It should have read/write on the application's
   databases and nothing else, and should not hold any Atlas administrative role.
3. Atlas → **Network Access**. If any entry is `0.0.0.0/0`, restrict it.
4. Review the cluster for activity that is not yours — unexpected collections,
   documents, database users or API keys. Assume the data was readable.

Then update `MONGODB_URI` in `backend/.env` and in `backend/.env.backup`, or
delete the backup file (see below).

### 2. Purge the commit from the remote — recommended

Removing the commit from the remote's history does **not** un-publish the
credentials: GitHub may continue serving unreferenced commits by SHA, and any fork
or scraper keeps its own copy. It is hygiene, not the fix. Rotation is the fix.

The leaked commit exists only on `origin/main`; the local `main` branch never
contained it and already supersedes it. So the purge is a force-push, not a
rewrite:

```
git fetch origin
git branch backup/origin-main-pre-purge origin/main   # local safety net
git push --force origin main
```

This drops `a9e8e7b` and `054c489` from the remote. Nothing of value is lost:
`a9e8e7b` only rewrote the old `backend/server.js`, which has since been replaced
by the current entry point, and `054c489` only added `backend/.env`.

Afterwards, ask GitHub Support to remove cached views of the old commit if you
want it gone from the web interface as well.

### 3. Decide whether the repository should stay public

`tamba981/the-box-lms` is public and contains this project's source. If that is
deliberate, keep it public and rely on rotation plus the ignore rules above. If it
was not, make it private.

### 4. Delete `backend/.env.backup`

It is a second plaintext copy of the same credentials. It is ignored by git, but
after the password is rotated it will hold a stale, useless secret. Deleting it is
safer than keeping it.
