# DNS and email for `wuteveglobalacademy.com`

Everything needed to make the domain serve the site **and** carry real mail. Two
systems share this one domain, and they must not fight each other:

| Purpose | Records | Where configured |
| ------- | ------- | ---------------- |
| The website | `A` / `CNAME` on `@` and `www` | Railway → Settings → Networking, then Namecheap |
| The mailbox (`wuteve@…`) | `MX`, SPF, DKIM, DMARC | Zoho Mail admin, then Namecheap |
| App email (verification, resets, receipts) | SPF + DKIM on a sending subdomain | Resend, then Namecheap |

Point of registration: **Namecheap**, nameservers on **Namecheap BasicDNS**. That
means every record below is entered in **Advanced DNS** for the domain — there is
no external DNS provider to log into.

---

## Step 0 — clear out the defaults that will break both

**Do this first.** A newly registered Namecheap domain ships pointing at
Namecheap's own parking page and email-forwarding service, and every one of those
records has to go. Until they do, the domain serves somebody else's page and mail
to it goes nowhere.

1. **Turn the Parking Page off.** Domain List → **Manage** → **Parking Page →
   TURN OFF**. This owns several of the records below, and it recreates them.
2. **Delete the apex `A` record.** It holds `162.255.119.228`, which is
   Namecheap's parking address, not the app.
3. **Delete the `CNAME` on `www`** pointing at `parkingpage.namecheap.com`.
4. **Delete the five `MX` records** pointing at `eforward1`–`eforward5.registrar-servers.com`,
   and the `TXT` reading `v=spf1 include:spf.efwd.registrar-servers.com ~all`.
   That is Namecheap's free email forwarding, on by default. With no forwarders
   configured, mail addressed to this domain currently goes nowhere — so
   `wuteve@wuteveglobalacademy.com` is not receiving anything yet, on any records.

Also delete any **`URL Redirect Record` for `@`**, if one exists. It is the same
parking mechanism under a different name, and it sends visitors *away* from the
server.

### What this domain resolved to before any of that was changed

Recorded here because these are the exact values to look for, and seeing them
confirms nothing was missed:

| Type | Host | Value | What it is |
| ---- | ---- | ----- | ---------- |
| `NS` | `@` | `dns1/dns2.registrar-servers.com` | Namecheap BasicDNS — correct, leave it |
| `A` | `@` | `162.255.119.228` | Namecheap parking **— delete** |
| `CNAME` | `www` | `parkingpage.namecheap.com` | Namecheap parking **— delete** |
| `MX` | `@` | `eforward1`–`eforward5.registrar-servers.com` | Namecheap email forwarding **— delete** |
| `TXT` | `@` | `v=spf1 include:spf.efwd.registrar-servers.com ~all` | Forwarding SPF **— delete** |

If you skip this step, every record below can be correct and the domain will still
not serve the site or receive a single message.

---

## Step 1 — the website (Railway → Namecheap)

1. Railway → your service → **Settings → Networking → Custom Domain**.
2. Add **`wuteveglobalacademy.com`**. Railway then displays the exact record to
   create. Create exactly that; do not substitute values from a guide, including
   this one.
3. Add **`www.wuteveglobalacademy.com`** the same way if you want `www` to serve
   the site directly.

Railway gives you a `CNAME` target for subdomains, and for the **root** host it
gives either a `CNAME` or an `A` record. BasicDNS does not accept a `CNAME` at the
root of a domain, so if Railway offers an `A` record, use it. Either way the value
comes from that dialog.

Then in **Advanced DNS**, add:

| Type | Host | Value | TTL |
| ---- | ---- | ----- | --- |
| `A` **or** `CNAME` | `@` | *exactly what Railway showed* | Automatic |
| `CNAME` | `www` | *exactly what Railway showed* | Automatic |

TLS is issued automatically once the records resolve. Nothing to buy.

> **Either `www` serves the site, or `www` redirects to the root — pick one, not
> both.** For a single canonical address (better for search engines and for the
> `PUBLIC_BASE_URL` you set in step 4), the tidier option is a redirect:
>
> | Type | Host | Value |
> | ---- | ---- | ----- |
> | `URL Redirect` | `www` | `https://wuteveglobalacademy.com` |
>
> A redirect on `www` is safe because nothing else needs that hostname. A redirect
> on `@` is not: it is the same mistake as step 0.

---

## Step 2 — the mailbox (Zoho → Namecheap)

Add the domain in Zoho Mail and create `wuteve@wuteveglobalacademy.com`. Zoho's
admin console then shows you its own verification string and DKIM key — **use
those**, they are specific to your account.

### MX records — these are what make mail arrive

| Type | Host | Value | Priority | TTL |
| ---- | ---- | ----- | -------- | --- |
| `MX` | `@` | `mx.zoho.com` | `10` | Automatic |
| `MX` | `@` | `mx2.zoho.com` | `20` | Automatic |
| `MX` | `@` | `mx3.zoho.com` | `50` | Automatic |

**Check which Zoho data centre your account is on before entering these.** Zoho
uses different hostnames per region and the wrong set silently receives nothing:

| Data centre | Hostnames |
| ----------- | --------- |
| Global (US) | `mx.zoho.com`, `mx2.zoho.com`, `mx3.zoho.com` |
| Europe | `mx.zoho.eu`, `mx2.zoho.eu`, `mx3.zoho.eu` |
| India | `mx.zoho.in`, `mx2.zoho.in`, `mx3.zoho.in` |
| Australia | `mx.zoho.com.au`, `mx2.zoho.com.au`, `mx3.zoho.com.au` |
| Japan | `mx.zoho.jp`, `mx2.zoho.jp`, `mx3.zoho.jp` |

### SPF, DKIM and DMARC

| Type | Host | Value |
| ---- | ---- | ----- |
| `TXT` | `@` | `v=spf1 include:zoho.com ~all` |
| `TXT` | `zoho._domainkey` | *the key Zoho shows you* |
| `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:wuteve@wuteveglobalacademy.com` |

Match the `include:` to your data centre — `include:zoho.eu` for Europe, and so on.
Start DMARC at `p=none`. Move it to `p=quarantine` once you have watched the
reports for a week and confirmed nothing legitimate is failing.

> ### ⚠️ A domain may have only **one** SPF record
>
> If you later add Resend's SPF, do not create a second `TXT` on `@` — two SPF
> records invalidate each other and break **all** your mail. Either merge the
> includes into the single record:
>
> ```
> v=spf1 include:zoho.com include:amazonses.com ~all
> ```
>
> …or, better, keep Resend on a subdomain, as below.

---

## Step 3 — the app's own email (Resend → Namecheap)

The application sends verification links, password resets and receipts. Those come
from Resend, not Zoho, and Resend will refuse to send until the domain is verified
— with records of its own.

In Resend: **Domains → Add Domain**. Use a **subdomain for sending**:

```
send.wuteveglobalacademy.com
```

Resend then shows the records to add, typically a `TXT` for DKIM, an `MX` and a
`TXT` for the sending subdomain. Add exactly those.

**Sending from a subdomain is deliberate.** It gives Resend its own SPF and its own
reputation, entirely separate from the mailbox people correspond with. If a bulk
send is ever marked as spam it cannot affect `wuteve@`, and you never have to merge
SPF records on the root domain.

Then set the sender address to match — see step 4.

---

## Step 4 — tell the application about the domain

These are Railway **service variables**, not DNS records. Set them in Railway →
your service → **Variables**. They cannot be set from the repository.

| Variable | Value | Why it matters |
| -------- | ----- | -------------- |
| `PUBLIC_BASE_URL` | `https://wuteveglobalacademy.com` | **No trailing slash.** It is the link inside every verification and password-reset email, and the address a payment returns to. Wrong here means dead links in real inboxes. |
| `EMAIL_FROM` | `Wuteve Global Academy <wuteve@wuteveglobalacademy.com>` | Must be on the domain verified in step 3. Until then Resend refuses to send. |
| `RESEND_API_KEY` | *from Resend* | Without it, verification and reset links are written to the log instead of sent. |
| `CORS_ORIGINS` | leave **unset** | Same-origin requests work without it — the guard compares the `Origin` header against the host the request arrived on. Only set it if a separate frontend origin must call the API. |

If you use the sending subdomain from step 3, the sender should be
`Wuteve Global Academy <wuteve@send.wuteveglobalacademy.com>` so that what appears
in an inbox matches what was verified.

> Set `PUBLIC_BASE_URL` **after** DNS resolves. Any email sent in the gap between
> configuring it and DNS going live carries a link that does not work yet.

---

## Step 5 — verify it worked

Website:

```bash
npm run verify:deploy -- https://wuteveglobalacademy.com
```

Ten checks from outside, including that a page is served, that `PUBLIC_BASE_URL`
matches the host being tested, and that a same-origin write is not blocked. Then:

```bash
curl https://wuteveglobalacademy.com/health
```

`"pages": { "present": true, "htmlFiles": 14 }` means the site is being served.

Mail — check DNS first, because it is faster than waiting for a bounce:

```powershell
Resolve-DnsName -Type MX wuteveglobalacademy.com
Resolve-DnsName -Type TXT wuteveglobalacademy.com
Resolve-DnsName -Type TXT zoho._domainkey.wuteveglobalacademy.com
```

Then send a message **from an outside address** to `wuteve@wuteveglobalacademy.com`
and reply to it. Receiving proves MX; replying proves SPF and DKIM. Check the reply
lands in the inbox rather than spam.

Finally, register a new account on the live site and confirm the verification email
arrives — that exercises Resend, `EMAIL_FROM` and `PUBLIC_BASE_URL` together, and
is the only test that covers all three at once.

---

## What is already done in the repository

- Every page already publishes `wuteve@wuteveglobalacademy.com` as the contact
  address. Until this domain was registered that address reached nothing, because
  the domain did not exist. **Once the MX records in step 2 resolve, it starts
  working** — no code change is needed for the contact address.
- `CORS_ORIGINS` in `.env.example` already names the domain.
- No page hard-codes a deployment hostname: `backend/scripts/check.js` fails the
  build if one does. Links are built from `PUBLIC_BASE_URL` at runtime.
