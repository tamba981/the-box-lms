# Social sign-in (Google and LinkedIn)

Google and LinkedIn sign-in is built and deployed. It is **switched off until
credentials exist**, because the credentials are the visitor's identity: there is
nothing to fake in a test.

While a provider is off:

- `GET /api/v1/auth/oauth/providers` reports `enabled: false` for it
- the button on the sign-in page still works, but it moves the visitor to the
  email form and says the method is not available yet, rather than sending them
  into a flow that will fail at the provider
- `/api/v1/auth/oauth/<provider>/start` redirects back to `/login.html` with a
  reason code instead of forwarding to the provider

Once both values for a provider are set, the button becomes a real sign-in with
no code change or redeploy of the frontend.

## What to create

### Google

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials →
   OAuth client ID → Web application**.
2. **Authorised redirect URI** — exactly:

   ```
   https://wuteveglobalacademy.com/api/v1/auth/oauth/google/callback
   ```

   For local testing add a second one:
   `http://localhost:5000/api/v1/auth/oauth/google/callback`
3. On the **OAuth consent screen**, the scopes used are `openid`, `email` and
   `profile` — nothing else is requested. While the app is in "Testing" only
   listed test users can sign in; publish it before launch.
4. Copy the client ID and client secret.

### LinkedIn

1. <https://www.linkedin.com/developers/apps> → **Create app**, associated with
   the Wuteve company page.
2. **Products** → request **Sign In with LinkedIn using OpenID Connect**. The
   legacy `r_liteprofile` / `r_emailaddress` products are not used: this flow
   reads `https://api.linkedin.com/v2/userinfo`, which returns the verified
   primary email as part of the OpenID claims.
3. **Auth** → **Authorised redirect URLs** — exactly:

   ```
   https://wuteveglobalacademy.com/api/v1/auth/oauth/linkedin/callback
   ```

4. Copy the Client ID and Primary Client Secret from **Auth**.

## Set the values

Railway → your service → **Variables**:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
```

`PUBLIC_BASE_URL` must already be the public origin; the callback URL is derived
from it. If `PUBLIC_BASE_URL` is wrong, the redirect URI will not match what is
registered at the provider and the provider will refuse the sign-in.

A provider with only one of its two values set stays off, and the server warns
about it at boot.

## How the flow works

```
browser → GET /api/v1/auth/oauth/google/start
        → 302 accounts.google.com  (state cookie set: HttpOnly, SameSite=Lax, 10 min)
google  → GET /api/v1/auth/oauth/google/callback?code=…&state=…
        → 302 /oauth-callback.html#code=<single-use, 2 min>
page    → POST /api/v1/auth/oauth/exchange { code }
        → 200 { user, accessToken, refreshToken }
```

Three details are deliberate:

- **The session is never in a URL.** The callback hands the page a single-use
  code, not tokens. A fragment is not sent to the server or to a proxy, the code
  expires in two minutes and is consumed once.
- **`state` is checked twice.** It is signed with the refresh secret *and* echoed
  in an HttpOnly cookie. The cookie is the CSRF half: an attacker who starts
  their own flow cannot make the victim's browser present the matching cookie.
- **The email is only trusted when the provider says it is verified.** The
  account is keyed on the address, so an unverified one would let somebody claim
  an existing account.

Google additionally gets PKCE (`S256`); LinkedIn's v2 endpoints do not support
it, so the verifier is only generated where it is honoured.

## Accounts

| Situation | What happens |
| --- | --- |
| Provider identity already linked | Signed in to that account |
| Email matches an existing account | The provider is linked to it; `emailVerified` is set, since the provider proved the address |
| No account with that email | A student account is created, email already verified, with a random password nobody is told — "Forgot password" is how it gets a usable one |
| Account is not `active` (suspended) | Refused, with a message to contact the academy |

Names come from the provider, trimmed and length-capped. `dateOfBirth` and
`location` are not required by the schema, so an account created this way works
immediately and can fill those in from the profile page.

## Verifying it

```bash
# which providers are live
curl -s https://wuteveglobalacademy.com/api/v1/auth/oauth/providers

# a provider that is off must never forward to the provider
curl -s -o /dev/null -D - https://wuteveglobalacademy.com/api/v1/auth/oauth/google/start | grep -i location
```

In a browser: sign in with the provider, and check that
`/oauth-callback.html` lands on the dashboard and that the address bar no longer
contains the code.

## Failure reasons the page understands

`reason=` in `/login.html?oauth=error&reason=…`, mapped to plain sentences in
`login.html`:

| Reason | Meaning |
| --- | --- |
| `cancelled` | The visitor pressed Cancel at the provider |
| `state_mismatch` | The callback did not match the cookie — a different browser, or a CSRF attempt |
| `INVALID_STATE` / `STATE_EXPIRED` | The state was forged, or older than ten minutes |
| `TOKEN_EXCHANGE_FAILED` | The provider rejected the code or the client credentials |
| `EMAIL_NOT_VERIFIED` / `NO_EMAIL` | The provider did not share a usable address |
| `ACCOUNT_NOT_ACTIVE` | The account exists but is suspended |
| `PROVIDER_NOT_CONFIGURED` | No credentials for that provider on this deployment |
