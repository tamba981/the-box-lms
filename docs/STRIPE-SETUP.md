# Stripe setup and the payment contract

Card payments are **disabled by default**. With no keys configured the platform
says so plainly rather than pretending: `POST /api/v1/payments/checkout/:courseId`
answers `503 PAYMENTS_DISABLED` with "Card payments are not configured on this
deployment. Please contact the academy to enroll." Free courses enrol directly and
never touch this path.

## Configuration

Three environment variables, all read at startup:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Server-side API key. Its presence is what enables payments. |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook deliveries. Without it every delivery is refused. |
| `PUBLIC_BASE_URL` | Used to build the success and cancel URLs, so it must be the real public origin. |

There is deliberately **no publishable key and no Stripe.js**. Checkout is Stripe's
hosted page and the browser is redirected to it, so no key material reaches the
client at all. `GET /api/v1/payments/config` reports `{ enabled, provider }` and
nothing else.

For test mode, take the keys from the Stripe dashboard while in **Test mode**:
Developers → API keys for the secret key, and Developers → Webhooks → your endpoint
for the signing secret. Put them in `backend/.env` directly; do not paste them
anywhere else, including into a chat or an issue.

## Local webhook testing

Stripe cannot reach `localhost`, so forward deliveries with the CLI:

```
stripe login
stripe listen --forward-to http://localhost:5000/api/v1/payments/webhook
```

`stripe listen` prints a signing secret beginning `whsec_`. Use that value for
`STRIPE_WEBHOOK_SECRET` while listening, and the endpoint's own secret in
production. To drive a full purchase, enrol with a test card
(`4242 4242 4242 4242`, any future expiry, any CVC).

## The contract the code enforces

These are the rules the implementation holds to, each covered by the test suite
(`npm run smoke`, section "Stripe webhook"). They exist because each one was
previously wrong or unverified.

1. **The price comes from the course document, never from the request.** A caller
   cannot choose what to pay.
2. **The webhook is the only signal that money moved.** Access is granted from the
   webhook, never from the browser redirect, which can be abandoned or spoofed.
3. **The signature is verified against the raw bytes**, over `${timestamp}.${body}`,
   with a timing-safe comparison and a 300-second window. A delivery older than
   that is refused as a replay. The route is mounted with `express.raw` *before*
   `express.json`, because re-serialised JSON will not match the signature.
4. **`checkout.session.completed` is not payment.** Fulfilment requires
   `payment_status === 'paid'`. With asynchronous methods that field can still be
   `unpaid` at completion, and fulfilling then would hand over a course before the
   money settled.
5. **The amount is checked before access is granted.** If `amount_total` or
   `currency` disagrees with the payment record, fulfilment is refused and the
   payment is left pending for a human. Recording revenue that never happened is
   worse than a stuck payment.
6. **Fulfilment is idempotent.** Stripe retries, and a student can click Pay twice;
   neither may produce two payments or two enrolments.
7. **Unhandled event types are acknowledged** so Stripe stops retrying, and a
   processing failure returns 500 so that it does retry.

## Known gap: refunds do not move money

`POST /api/v1/payments/:id/refund` (admin only) marks the payment `refunded` and
cancels the enrolment. **It does not call Stripe.** The money is not returned to
the student.

The admin dashboard says so explicitly — the button reads "Mark refunded", and the
confirmation warns that the refund itself has to be issued in Stripe — but this is
a gap, not a design choice. Closing it means calling
`POST https://api.stripe.com/v1/refunds` with the payment's
`providerPaymentIntentId` and only marking the record refunded once Stripe
confirms. That is the next piece of work on this integration, and it needs live
test keys to verify.

## Go-live checklist

- [ ] Test-mode keys in place, and a full purchase completed with `4242 4242 4242 4242`
- [ ] The webhook endpoint registered in Stripe against the **public** URL, not localhost
- [ ] `PUBLIC_BASE_URL` set to the real origin, or success and cancel URLs will point at localhost
- [ ] A real delivery accepted and visible in Stripe's webhook log
- [ ] The refund gap above either closed or accepted knowingly
- [ ] Live keys added only after the above, and never committed — `.env` is ignored
      by `.gitignore` via the `.env` and `.env.*` rules, with `.env.example` as the
      only tracked template
