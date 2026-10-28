# AI features (tutor, mentor, assessments)

OpenRouter-backed assistants for students and instructors, with a daily credit
allowance so the cost is bounded by the number of students rather than by how
much any one of them enjoys asking questions.

## What exists

| Feature | Who | Cost | Where |
| --- | --- | --- | --- |
| AI Tutor | Students, on a lesson they can already read | 1 credit | `POST /api/v1/ai/tutor` |
| AI Mentor | Students | 1 credit | `POST /api/v1/ai/mentor` |
| Career assessment | Students | 5 credits | `POST /api/v1/ai/career-assessment` |
| Course insights | The course's instructor or an admin | free | `GET /api/v1/ai/insights?courseId=` |
| Feedback draft | The course's instructor or an admin | free | `POST /api/v1/ai/feedback-draft` |
| Balance | Any signed-in user | free | `GET /api/v1/ai/credits` |

## Credits

- **Daily allowance** — `AI_DAILY_CREDIT_LIMIT`, default **10**. Resets at
  midnight **UTC**.
- **Bonus credits** — `aiCredits.bonus` on the user. These do not reset daily, and
  they add to the allowance rather than replacing it. Nothing grants them
  automatically yet; an administrator or a future purchase flow can.

### Who gets what

The tier is decided by the courses a student is **actually enrolled in**, best
first:

| Tier | Condition | Allowance |
| --- | --- | --- |
| `staff` | Instructor or administrator | Unlimited |
| `premium` | Any live enrolment at or above `AI_PREMIUM_PRICE_CENTS` (default 5000) | Unlimited |
| `paid_course` | Any enrolment with `priceCents > 0` **or** `certificateFeeCents > 0` | 10 a day |
| `free_course` | Enrolled, but every course is completely free (no price **and** no certificate fee) | **None** |
| `no_course` | Not enrolled in anything | 10 a day |

`free_course` is the reason a completely free course does not also come with AI:
ten questions a day on a course that charges nothing is a cost with no revenue
against it, and the tutor is the most expensive thing the platform offers.

`no_course` keeps the allowance because there is no course to tutor on — the
mentor is how a new account finds out what to take.

Bonus credits lift a `free_course` account: they were given or bought
deliberately, so the course price stops deciding. That is the hook a purchased
bundle would use.

Unlimited is **computed, never stored**, so it cannot go stale when an enrolment
ends.

Spending is a **single conditional update**: `used` only increases if
`used + cost <= limit + bonus`, so two tabs cannot spend the same last credit. If
the provider then fails, the credits are **refunded** — nobody pays for an answer
that never arrived.

The counter is per user, per UTC day, and resets lazily on the first AI call of
the new day. There is no scheduled job.

## Why these guardrails exist

- **The tutor can only see a lesson the student may already read.** Same check as
  the lesson page: enrolment, ownership, or a published preview. Without it the
  tutor would be a way to read paid course content one question at a time.
- **The tutor is grounded.** It is given the lesson text (HTML stripped, capped at
  8,000 characters) and told to answer only from it, saying so when the answer is
  not there.
- **The student's question is fenced.** It arrives inside
  `<student_question>`…`</student_question>` with an explicit instruction to treat
  it as a question and never as instructions. A grounded tutor that follows
  "ignore the lesson" has stopped being grounded.
- **Invented courses are dropped.** The career assessment is given the real
  course titles and asked to recommend only those; any title it invents anyway is
  removed before the student sees it.
- **Nothing is exposed to the browser but the answer.** The key never leaves the
  server, and no request body can select a model, a temperature or a price.

## Cost

Tokens are recorded per call in `AIUsageLog`, with an estimate derived from
`AI_PRICE_IN_PER_MTOK` / `AI_PRICE_OUT_PER_MTOK`. Nothing is billed from those
numbers — they are there so "what is this costing?" has an answer that is not a
guess.

At `openai/gpt-4o-mini` rates, one tutor question (≈500 in, ≈200 out) is about
**$0.0002**. Ten credits a day for a free student is therefore under a cent a day:

```
100 free students × 10 credits × 30 days ≈ $6/month
```

Instructors are unlimited, so their usage is the figure to watch. `AIUsageLog`
answers that per course and per day.

## Setting it up

Railway → Variables:

```
OPENROUTER_API_KEY=sk-or-v1-...
AI_MODEL=openai/gpt-4o-mini
AI_DAILY_CREDIT_LIMIT=10
```

The model id **must** include its provider prefix — OpenRouter addresses models as
`vendor/model`. A bare `gpt-4o-mini` is rejected by the API, so the server warns at
boot if `AI_MODEL` has no `/`.

With no key, every AI endpoint answers `503 AI_NOT_CONFIGURED` and names the
missing variable; the rest of the platform is unaffected.

## Failure codes

| Code | Status | Meaning |
| --- | --- | --- |
| `AI_NOT_CONFIGURED` | 503 | No `OPENROUTER_API_KEY` on this deployment |
| `AI_PURCHASE_REQUIRED` | 403 | The student's courses are all completely free, so there is no allowance. Credits are not deducted and the provider is not called |
| `AI_CREDITS_EXHAUSTED` | 403 | Today's allowance is spent; credits are not deducted |
| `AI_UNREACHABLE` | 503 | The provider could not be contacted; credits are refunded |
| `AI_PROVIDER_ERROR` | 503 | The provider refused the request; credits are refunded |
| `AI_EMPTY_RESPONSE` | 503 | A 200 with no content; credits are refunded |
| `AI_BAD_JSON` | 503 | The assessment answer could not be parsed; credits are refunded |
| `ENROLLMENT_REQUIRED` | 403 | The lesson is not one this student may read |
| `LESSON_HAS_NO_TEXT` | 400 | Nothing written in the lesson to ground an answer |

## Privacy

An AI tutor call stores a **200-character** copy of the student's question in
`AIUsageLog`, attached to the course. That is what lets an instructor see which
part of a lesson students keep asking about. It is disclosed on the privacy page;
nothing else about the question is kept, and the answer is not stored at all.

## Testing

The suite stubs `global.fetch` for the provider, so the real credit ledger, the
real prompt building and the real response parsing run without any request
leaving the runner:

```bash
cd backend && npm test
```

It covers: the balance endpoint, refusal when not enrolled, one credit per tutor
question, exhaustion at the limit with **no provider call**, staff unlimited,
premium unlimited, the mentor's context, the assessment's five credits and the
invented-course filter, the usage log, instructor-only insights and feedback
drafts.
