# Accounts: email changes, impersonation, and the public counters

Three things an administrator asked for in October 2026, and the decisions behind
them. They are documented together because all three are about the gap between
what an account *is* in the database and what a page *shows* about it.

## Changing your own email address

Every signed-in account — student, instructor, administrator — can change its own
email address from the dashboard, in **My Account**. The request is
`PATCH /api/v1/auth/me` with `{ "email": "new@example.com" }`.

What happens when the address changes:

1. The address is lower-cased and checked for uniqueness. A clash returns
   `409 EMAIL_IN_USE`.
2. `emailVerified` goes back to `false`, so the new address has to prove itself
   even though the old one already had.
3. A verification link goes to the **new** address, and a notice goes to the
   **old** one. The notice is the security half: if somebody with a borrowed
   session changes the address, the real owner is told and still has a working
   address to recover from.

No password is required for an email change. That is deliberate — sign-in does
not require `emailVerified`, only `status: active`, so a typo in the new address
cannot lock anybody out; they can still sign in and correct it.

## Impersonation: an administrator opening a user's account

`POST /api/v1/admin/users/:id/impersonate` with `{ "reason": "..." }`.

The password is never used, never asked for, and never changed. The point is to
leave the account exactly as it was while an administrator looks at what the
student sees.

Rules, in the order they are checked:

| Case | Answer |
| --- | --- |
| Target is the administrator themselves | `400 SELF_IMPERSONATION` |
| Target is another administrator | `403 CANNOT_IMPERSONATE_ADMIN` |
| Target is `pending`, `suspended`, or `rejected` | `400 ACCOUNT_NOT_ACTIVE` |
| Target is an active student or instructor | A normal session for that user is issued |

The self-check runs first. An administrator is also an administrator, so with the
role check first the self case was reported as "administrator accounts cannot be
opened this way" — true, but about the wrong thing.

Another administrator is refused not because it is technically harder but because
an impersonated admin session can do everything an admin can while every record
names somebody else. Support conversations are about students and instructors.

Every session is written to the `impersonations` collection **before** the tokens
are issued — administrator, user, the required reason, IP, user agent, and start
time. `GET /api/v1/admin/impersonations` returns the trail, newest first.

On the client, the administrator's own tokens are parked in `localStorage` under
`wga.adminSession` before the user's session replaces them. `wga-ui.js` paints a
fixed banner on every page while that key is present, and its **Return to admin**
button restores the parked session and goes back to `/admin-dashboard.html`. The
banner is on every page rather than only the dashboards because a lesson page is
exactly where an administrator would be checking something.

## Public counters

`GET /api/v1/stats/public` feeds the figures in the site header, and nothing about
them is hard-coded — the page claimed fixed numbers, and every one went stale the
moment a course was published or an instructor was approved.

| Figure | Counted from |
| --- | --- |
| Courses, lessons, hours, free courses | Published courses only, because that is what a visitor can enrol in |
| Instructors | `User.countDocuments({ role: 'instructor', status: 'active' })` |

The instructor figure used to be the number of distinct instructor *names* on
published courses. That reported one for an academy that has two, because an
instructor who has not published a course yet is invisible to that count — and
the user's own diagnosis ("is it because the instructor has not created a
course?") was exactly right.

Counting from the accounts makes the number respond to the things an
administrator actually does:

- Approving an instructor application (`pending` → `active`) raises it.
- Suspending an instructor lowers it, because a suspended account cannot teach.
- Deleting the account lowers it, because there is nothing left to count.
- Publishing or deleting a course changes the course figures on the next load.

The response is cached for 30 seconds (`Cache-Control: public, max-age=30`): long
enough that a visitor refreshing repeatedly does not re-count the catalogue, short
enough that a change lands promptly.
