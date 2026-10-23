# Course reviews

A student who is enrolled in a course can write one review of it. Reviews are
moderated before they are shown, and only approved reviews count towards the
rating on the course card.

## The rules

| Rule | Where it is enforced |
| ---- | -------------------- |
| One review per student per course; a second submission replaces the first | `Review` schema, unique index on `(course, student)` |
| Only an enrolled student may review | `assertEnrolled` in `src/routes/reviews.js` (a cancelled enrolment does not count) |
| A review is private until an administrator approves it | `status` defaults to `pending`; the public list filters on `approved` |
| Editing a published review sends it back to moderation | `POST /courses/:id/reviews` resets `status`, clears the earlier decision |
| The author always sees their own review, including a refusal and its reason | `Review.toJSONForViewer` |
| A course's rating is the mean of its approved reviews | `reviewService.recomputeCourseRating`, called on every write that changes visibility |

A rating is never stored on the review. `ratingSum` and `ratingCount` live on the
course and are recomputed with an aggregation rather than incremented, so a missed
update cannot leave a course score permanently wrong.

## API

Student-facing, mounted under the course:

| Method | Path | Who | Purpose |
| ------ | ---- | --- | ------- |
| `GET` | `/api/v1/courses/:courseId/reviews` | anyone (published courses) | Approved reviews, star summary, and the caller's own review |
| `POST` | `/api/v1/courses/:courseId/reviews` | enrolled student | Create or replace a review; returns `201` on the first, `200` after |
| `DELETE` | `/api/v1/courses/:courseId/reviews/mine` | the author | Withdraw a review |

`:courseId` accepts either the id or the slug.

`GET` accepts `page`, `limit` and `sort` (`newest`, `highest`, `lowest`).

Administrator, under `/api/v1/admin`:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/reviews?status=pending\|approved\|rejected\|all` | The moderation queue, with counts |
| `POST` | `/reviews/:id/approve` | Publish a review and count it |
| `POST` | `/reviews/:id/reject` | Refuse it; the body carries a `reason` the author sees |
| `DELETE` | `/reviews/:id` | Remove it permanently and recompute the course |

Approval and rejection both write an in-app notification to the author. A failed
notification is logged and does not roll back the decision.

## Where it appears

- **Course page** — a `Reviews` tab, opened by `?tab=reviews`, showing the average,
  the count, the published reviews, and a form for an enrolled student. A pending
  or rejected review is shown above the form with its state.
- **Course cards and the course meta row** — `rating` and `ratingCount` come from
  the course record, so the catalogue and the page cannot disagree.
- **Admin dashboard** — the `Reviews` page is the queue: filter by status, read the
  full text of a pending review, approve, reject with a reason, or delete.

## Checking it

`backend/scripts/smoke.js` has a `Course reviews` suite covering eligibility,
validation, moderation, the rating counters, editing, withdrawal and the 404 path.
It is part of `npm test`.
