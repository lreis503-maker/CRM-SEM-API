# WhatsApp connection troubleshooting

Settings → WhatsApp connection talks to the Meta Graph API in a fixed
order when you click **Save Configuration**. When one of those calls
fails, wacrm now tells you *which* call failed, *which field* to check,
and gives you the Meta error code and trace id to quote to Meta support
(issue #505). This page lists the common causes and the exact text
wacrm shows for each.

## What Save Configuration does

| Step (shown in the error details) | Meta call | Proves |
| --- | --- | --- |
| *(before any Meta call)* | — | Phone Number ID and WABA ID are digit strings |
| `verify_number` | `GET /{phone_number_id}` | the token can read the number |
| `waba_phone_numbers` | `GET /{waba_id}/phone_numbers` | the number really lives under that WABA |
| `register` | `POST /{phone_number_id}/register` (only when a PIN is entered) | the number is registered with the Cloud API for inbound webhooks |
| `subscribe_waba` | `POST /{waba_id}/subscribed_apps` | the WABA is subscribed to your Meta App, so webhooks are delivered |

The first four failures stop the save; nothing is written until the
cause is fixed. A `register` failure still saves the credentials (so
you can retry with only the PIN) and shows the reason in the
*Registration status* banner.

**Test API Connection** re-runs `verify_number` with the stored token
and, when a WABA ID is on file, reads `GET /{waba_id}/subscribed_apps`
and reports whether the WABA is subscribed to an app. Valid
credentials plus an unsubscribed WABA is exactly the "connected but no
messages arrive" state.

## Reading the error details

Under the actionable message, small muted text shows:

```
Step: verify_number · Meta error code: 190/463 · Trace ID: AbCdEf...
Meta said: Error validating access token: Session has expired ...
```

* **Step** — the row in the table above.
* **Meta error code** — `code/subcode` from Meta's envelope. The
  [Cloud API error code reference](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
  documents every value.
* **Trace ID** — Meta's `fbtrace_id`. Meta support can look up the
  request with it; quote it together with the code.

The HTTP status also tells you who has to act: **400** means the fix
is on the settings form (token, ids, PIN); **502** means Meta has to
change something (rate limit, restriction, outage).

## Common causes and what wacrm shows

### Phone Number ID is not an id

*Cause:* the phone number (`+1 555 ...`) or a display name was pasted
instead of the numeric id.

> Phone Number ID must contain only digits — it is the numeric id shown
> under Meta → WhatsApp → API Setup, not the phone number itself.

The same check runs for the WABA ID:

> WhatsApp Business Account ID must contain only digits — copy it from
> Meta → WhatsApp → API Setup.

### Access token expired or invalid (code 190)

*Cause:* the 24-hour temporary token from the API Setup page was used,
or a System User token was revoked / reset.

> The access token has expired. Temporary tokens from the API Setup
> page expire after 24 hours. Generate a permanent token in Meta
> Business Settings → System Users → Generate token, with the
> whatsapp_business_management and whatsapp_business_messaging
> permissions, and paste it into Permanent Access Token.

(The first sentence varies with the subcode: "has been invalidated" for
460/467, "Meta rejected the access token as invalid" otherwise.)

### Token lacks permissions (code 10, 200–299)

*Cause:* the System User token was generated without
`whatsapp_business_management` / `whatsapp_business_messaging`, or the
System User was never assigned to the WABA.

> The access token is not allowed to perform this action (subscribing
> the WhatsApp Business Account to the app). Its System User needs the
> whatsapp_business_management and whatsapp_business_messaging
> permissions AND must be assigned to this WhatsApp Business Account
> (Business Settings → System Users → Add assets → WhatsApp accounts).
> Then generate a new token.

Code 131005 (access denied) gets a similar message naming the id that
was refused.

### Wrong Phone Number ID or WABA ID (code 100 "Unsupported get request", code 33)

*Cause:* the id is mistyped, or it belongs to a different Business
portfolio than the one the token was generated in.

> Meta cannot find Phone Number ID 1234567890, or the business that
> owns the access token does not own it. Copy the Phone Number ID
> exactly from Meta → WhatsApp → API Setup and check the token was
> generated inside the same Business portfolio.

When the failing step is WABA-scoped the message names the
*WhatsApp Business Account ID* instead.

### Phone number is under a different WABA

*Cause:* both ids are valid, but the WABA you typed does not own the
number. Before #505 this saved fine and subscribed the wrong WABA — the
webhook simply never fired.

> Phone Number ID 111 does not belong to WhatsApp Business Account 999.
> Meta lists these numbers under it: +1 555-0100 (222), +1 555-0200
> (333). Check both values in Meta → WhatsApp → API Setup: the WABA ID
> shown there must be the one that lists this phone number.

### Number not registered with the Cloud API (code 133010)

> This phone number is not registered with the WhatsApp Cloud API yet.
> Enter the two-step verification PIN below and save again so wacrm can
> register it (POST /register).

### Wrong two-step PIN (codes 133005, 136025)

> The two-step verification PIN is wrong. Use the 6-digit PIN set in
> WhatsApp Manager → Phone numbers → Two-step verification (or reset it
> there), then save again.

Too many wrong guesses (133008 / 133009) lock attempts for a while:

> Meta has temporarily locked PIN attempts for this number after too
> many wrong guesses. Wait a while before saving again with the correct
> PIN.

### Account restricted by Meta (code 131031, 368)

Nothing in wacrm fixes this — it is a Meta policy or verification
state.

> Meta has restricted or locked this WhatsApp Business Account, so
> nothing in wacrm can connect it. Open Meta Business Manager → Account
> quality (or WhatsApp Manager → Overview) to see the restriction and
> appeal it.

### Rate limited (codes 4, 17, 32, 613, 80007, 130429, …)

> Meta is rate-limiting this app or WhatsApp Business Account right
> now. Nothing needs changing — wait a few minutes and try again.

### Temporary Meta-side failure (codes 1, 2, 131000, 133004, 133016)

> Meta returned a temporary error while reading the phone number (code
> 131000). Retry in a minute; if it keeps happening, check
> metastatus.com and quote the trace id to Meta support.

### Anything else

Unknown codes keep Meta's own words plus the trace id:

> Meta returned an error while registering the phone number (code
> 12345/6): <Meta's message>. Trace id AbCdEf.

If the server cannot reach `graph.facebook.com` at all:

> Could not reach the Meta Graph API while reading the phone number:
> fetch failed. Check that this server has outbound internet access to
> graph.facebook.com and try again.

## Credentials valid, but no messages arrive

1. Click **Test API Connection**. If it says *"The WhatsApp Business
   Account is not subscribed to this app"*, re-enter the token and save
   again — the save subscribes the WABA.
2. Check the *Registration status* banner. *Not registered* means
   `/register` never succeeded for this number; enter the two-step PIN
   and save.
3. Click **Verify with Meta** for a per-check breakdown
   (`phone_metadata_ok`, `waba_subscribed_to_app`,
   `locally_marked_registered`).
4. Confirm the webhook itself: in the Meta App → WhatsApp →
   Configuration, the callback URL must be `https://<your host>/api/whatsapp/webhook`,
   the verify token must match the one saved here, and the `messages`
   field must be subscribed. `META_APP_SECRET` in the server
   environment must be *that* app's secret, or every delivery is
   rejected with a 401 before wacrm looks at it.

## The account is on UAZAPI, not Meta

Everything above is about the official Meta Cloud API. An account that
connects by QR code through UAZAPI has no Meta credentials at all, so
Settings shows the QR panel instead of the token form and this page
mostly does not apply. See [uazapi.md](./uazapi.md) for that flow.

What you can still hit:

| Symptom | Cause | Fix |
| --- | --- | --- |
| The UAZAPI option is visible but disabled | the server has not enabled it | set `UAZAPI_ENABLED`, `UAZAPI_BASE_URL`, `UAZAPI_ADMIN_TOKEN` and a public HTTPS `NEXT_PUBLIC_SITE_URL` |
| `uazapi_request_failed` with reason `authentication` | UAZAPI rejected the admin token or the instance token (401/403) | check `UAZAPI_ADMIN_TOKEN`; if only one account is affected, remove the connection and pair again |
| `uazapi_request_failed` with reason `not_found` | the instance was deleted upstream (404) | remove the connection in Settings and pair again |
| `uazapi_request_failed` with reason `rate_limited` or `upstream_unavailable` | 429, a 5xx, or a timeout | retry; the CRM never retries a send on its own |
| Status stays *Waiting for the QR code* | the code expired after 2 minutes | **Generate a new QR code** — it reuses the same instance |
| Status is *Session paused* (`hibernated`) | UAZAPI hibernated the session, credentials preserved | **Reconnect** |
| Connected, but no inbound messages | `NEXT_PUBLIC_SITE_URL` is not publicly reachable, so the callback never arrives | set the real public HTTPS origin and pair again so the webhook is re-registered |
| A Meta-only action answers HTTP 409 | `provider_not_supported` — templates, template sync, broadcasts, interactive, reactions and location are Meta-only | switch the account back to Meta, or use text/media |
| An attachment is gone after two days | media mirroring is off for the account | turn on inbound media mirroring in Settings; UAZAPI hosts files for 2 days only |

A send whose outcome was never confirmed — a timeout or a dropped
connection — is recorded as failed and is **never** retried
automatically. Repeating it could deliver the same message twice to a
real person, so the resend is a deliberate action.

### Reading UAZAPI own webhook errors

UAZAPI exposes `GET /webhook/errors`, which lists deliveries it could
not hand over. It is authenticated with the **instance** token, which
this CRM stores encrypted and never displays.

To inspect it, run the request from the server with the token read out
of the environment — never paste a token into a ticket, a chat message
or a shell history file:

```bash
# Prompted, not typed as an argument, so it stays out of shell history.
read -rs UAZAPI_INSTANCE_TOKEN
curl -sS -H "token: $UAZAPI_INSTANCE_TOKEN" "$UAZAPI_BASE_URL/webhook/errors"
```

The CRM side of the same question is the `whatsapp_webhook_quarantine`
table: one row per payload shape the normalizer could not read, redacted,
counted and deleted after seven days. A healthy account has none.

## Where the mapping lives

* `src/lib/whatsapp/meta-error-explain.ts` — code → explanation, field,
  and 400/502 side. Pure and unit-tested; add new codes there.
* `src/lib/whatsapp/waba-pairing.ts` — id format check and the
  phone-under-WABA check.
* `src/app/api/whatsapp/config/route.ts` — the connect flow. Every
  Meta failure returns `{ error, meta: { code, subcode, fbtrace_id,
  step, field, message } }`.
