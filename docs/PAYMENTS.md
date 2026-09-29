# Payments

Three methods are wired in. Two are mobile money networks, one is cards. **None of
them is currently able to take a payment**, and this document explains exactly why
for each, and what is needed to change that.

`GET /api/v1/payments/methods` reports the same thing at runtime, so the site can
never claim a method works when it does not:

```json
{ "methods": [
  { "id": "card",           "enabled": false, "missing": ["STRIPE_SECRET_KEY"] },
  { "id": "orange_money",   "enabled": false, "missing": ["ORANGE_MONEY_BASE_URL", "..."] },
  { "id": "lonestar_momo",  "enabled": false, "missing": ["LONESTAR_MOMO_BASE_URL", "..."] }
] }
```

## The card problem: Stripe does not support Liberia

This is the reason cards are not simply a matter of adding a key. Checked against
Stripe's own country list (`stripe.com/global`):

| Country | Listed as a Stripe country |
|---|---|
| Ghana | yes |
| Nigeria | yes |
| Kenya | yes |
| South Africa | yes |
| **Liberia** | **no** |
| Sierra Leone | no |
| Guinea | no |

Stripe is not available to businesses registered in Liberia. An account requires a
business entity and a bank account in one of the supported countries. So "add
Stripe keys" will not make cards work here — this needs a different resolver:

1. **A regional gateway that covers Liberia.** Candidates to check directly:
   Flutterwave, Paystack, DPO. I could not verify their Liberian coverage from this
   machine — both blocked the request — so treat this as a lead, not a finding.
   Whatever you pick needs adding to the provider registry as a fourth entry.
2. **A business entity in a supported country**, if that is realistic for you.

The Stripe implementation already in `paymentService.js` is correct and tested. It
is worth keeping: it works the moment a supported entity exists, and it is the
reference implementation the card gateway should be modelled on.

## What is implemented, and what is not

Implemented and covered by tests (see the "Mobile money" and "Stripe webhook"
sections of `npm run smoke`):

- provider registration and honest availability reporting
- phone normalisation to E.164 (`+231XXXXXXXX`), refusing nonsense
- charge initiation, with a pending payment created first so a failure cannot
  strand one
- callback signature verification — HMAC over the raw bytes with a five-minute
  replay window, timing-safe comparison
- settlement through a single shared path, so a mobile money payment and a Stripe
  payment cannot diverge on idempotency or amount checking
- refusal to settle when the amount or currency disagrees with the record
- the enrolment records `source: 'mobile_money'` so it is traceable

**Not implemented: the two HTTP calls to Orange Money and Lonestar MoMo.** I do not
have their API documentation, and inventing an endpoint shape or an authentication
scheme would produce code that looks finished and fails against real money. Both
functions throw rather than guess:

```
src/services/mobileMoneyService.js
  requestOrangeMoneyCharge()    <- fill in
  requestLonestarMomoCharge()   <- fill in
```

Each must return `{ reference }` — the provider's transaction id — and may return
`{ instructions }` for the payer. Use `payment._id` as the merchant reference so a
retried request cannot open two charges. Nothing else in the file changes.

## What to request from Orange Money and Lonestar Cell MTN

Ask each provider for the same list. Without most of these the integration cannot
be finished:

1. **Merchant/settlement account**, and its **merchant ID**.
2. **Sandbox and production base URLs** — separate values.
3. **Authentication**: API key or client id/secret, and whether it is OAuth with
   expiring tokens.
4. **The collection endpoint**: request fields, and the response field carrying the
   transaction id.
5. **How the payer approves**: a USSD push, a redirect, or an OTP by SMS. This
   decides what `instructions` should say and whether a redirect URL is needed.
6. **The callback**: URL format, payload shape, and — most importantly — **how they
   authenticate it**. If they sign with their own scheme, or use an IP allowlist or
   a bearer token, `verifyCallback` must be replaced with theirs.
7. **A transaction-status query endpoint.** Needed for reconciliation, and for the
   case where a callback never arrives — which is the failure mode that loses money
   quietly.
8. **Fees and settlement timing**, so the revenue figures can be read correctly.

Also worth asking both: whether they have an **aggregator** relationship that
covers both networks from one integration. If so, the two functions collapse into
one and half this work disappears.

## Configuration

Add to `backend/.env` as the credentials arrive. Nothing is enabled until all four
of a provider's values are present, and the API will name whichever are missing.

```ini
ORANGE_MONEY_BASE_URL=
ORANGE_MONEY_MERCHANT_ID=
ORANGE_MONEY_API_KEY=
ORANGE_MONEY_CALLBACK_SECRET=
ORANGE_MONEY_CURRENCY=lrd

LONESTAR_MOMO_BASE_URL=
LONESTAR_MOMO_MERCHANT_ID=
LONESTAR_MOMO_API_KEY=
LONESTAR_MOMO_CALLBACK_SECRET=
LONESTAR_MOMO_CURRENCY=lrd
```

`.env` is ignored by git; `.env.example` is the only tracked template. Never paste
a key into a chat, an issue or a commit.

## Callback endpoint

```
POST /api/v1/payments/callback/:provider
X-Callback-Signature: t=<unix seconds>,v1=<hmac_sha256(secret, "t." + rawBody)>
```

Body, normalised — map the provider's own field names onto this shape before it
reaches `processCallback`, so the settlement rules stay in one place:

```json
{ "reference": "...", "status": "paid", "amountCents": 30000, "currency": "lrd", "transactionId": "..." }
```

Mounted with `express.raw` before `express.json`, because the signature covers the
exact bytes. It answers 400 for a delivery it will never accept, 200 for one it has
applied or deliberately ignored, and 500 on a processing failure so the provider
retries — settlement is idempotent, so a retry is safe.

## Known gap: refunds do not move money

`POST /api/v1/payments/:id/refund` marks the payment refunded and cancels the
enrolment. It does not call the provider, so **no money is returned**. The admin
dashboard says so plainly — the button reads "Mark refunded" and the confirmation
warns that the refund must be issued in the provider's dashboard. Closing this gap
needs a refund capability per provider, and cannot be done until the providers are
integrated.

## Order of work

1. Decide the card route — a regional gateway, or a supported-country entity.
2. Get Orange Money and Lonestar API documentation, then fill in the two functions.
3. Build reconciliation on the transaction-status query, so missed callbacks are
   detected rather than silently costing money.
4. Implement refunds per provider.
5. Only then consider live credentials. Test in each provider's sandbox first.
