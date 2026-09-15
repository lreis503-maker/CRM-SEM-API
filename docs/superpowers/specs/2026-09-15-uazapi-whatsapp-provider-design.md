# UAZAPI WhatsApp Provider Design

**Date:** 2026-09-15

**Status:** Approved in conversation; awaiting review of this written specification

**Source contract:** UAZAPI OpenAPI 3.1, version 2.1.1, supplied as `uazapi-openapi-spec.yaml`

## 1. Goal

Add UAZAPI as a second WhatsApp provider without regressing the existing Meta Cloud API integration. Each CRM account chooses exactly one active provider. Meta keeps its current credential-based connection flow; UAZAPI is provisioned by the CRM installation and connects through a QR code in Settings.

The first UAZAPI release supports the operational core:

- connect, reconnect, inspect status, and disconnect an instance;
- inbound and outbound one-to-one text messages;
- inbound and outbound image, video, audio, and document messages;
- Inbox persistence, contacts, conversations, media mirroring, flows, and automations where their actions use supported message types;
- message delivery status updates when UAZAPI supplies them.

Meta-only features remain visible but disabled while UAZAPI is selected:

- message models/templates;
- template synchronization;
- template sends, including broadcasts;
- template actions in automations;
- any flow action that requires an unsupported interactive or template message.

This version does not add groups, newsletters, menus, buttons, lists, reactions, locations, contacts, payments, history synchronization, or UAZAPI campaigns. The UAZAPI contract exposes some of them, but supporting them now would widen the shared contract without a product requirement.

## 2. Architectural Decision

Evolve the existing `whatsapp_config` row with a provider discriminator and add provider adapters around the real shared operations. Do not create parallel Meta and UAZAPI configuration tables, and do not scatter `if (provider)` branches through features.

The alternatives were:

1. **Selected: one account configuration plus adapters.** This preserves the current one-number-per-account invariant, keeps the Meta migration small, and creates a clean boundary for outbound and inbound operations.
2. Separate configuration tables per provider. This isolates schemas but makes account ownership, provider switching, status loading, and future common settings harder to keep consistent.
3. Add UAZAPI calls directly to each current sender and webhook. This has the smallest first diff but duplicates branching across Inbox, automations, flows, broadcasts, and settings, making Meta regressions likely.

The shared interface contains only capabilities that are truly common. Meta template APIs remain Meta-specific; UAZAPI does not pretend to implement them.

## 3. Components And Boundaries

### 3.1 Provider model and capabilities

Create a small provider domain under `src/lib/whatsapp/providers/`:

- `types.ts`: provider names, connection states, send inputs/results, normalized inbound events, and capability names;
- `capabilities.ts`: the static capability map and assertion helpers;
- `resolve-provider.ts`: load the account configuration, decrypt only the selected provider token, and return the matching adapter;
- `meta-provider.ts`: a thin wrapper around the existing `meta-api.ts` text/media behavior;
- `uazapi-provider.ts`: UAZAPI text/media adapter;
- `uazapi-client.ts`: authenticated HTTP client and runtime response parsing;
- `uazapi-normalizer.ts`: turn documented and defensively recognized webhook shapes into the internal event model.

Connection management remains provider-specific because Meta registration and a QR session do not share useful semantics. UAZAPI instance lifecycle code lives in a focused `uazapi-instance.ts` service. Existing Meta registration calls remain in their current Meta-specific service boundary.

The capability map is the only source used to decide whether a provider supports an operation. Initial capabilities are:

| Capability | Meta | UAZAPI |
| --- | --- | --- |
| Connection status | yes | yes |
| Send text | yes | yes |
| Send media | yes | yes |
| Receive text/media | yes | yes |
| Meta 24-hour service window | yes | no |
| Templates/models | yes | no |
| Template synchronization | yes | no |
| Broadcasts | yes | no |
| Interactive messages | existing Meta behavior | no in v1 |
| Reactions and location | existing Meta behavior | no in v1 |

### 3.2 Outbound boundary

`send-message.ts` remains the application entry point for persisted one-to-one sends. It resolves the account provider and delegates text/media transport to the adapter. Provider adapters return a common result containing the external message id, accepted timestamp when present, and initial status.

The existing automation and flow send helpers stop calling Meta directly for text/media and delegate to the same application sender. Template paths assert the Meta capability before reading templates or creating message rows. Broadcast creation, resume, scheduling, and public API routes assert the broadcast capability before producing queue side effects.

UAZAPI uses:

- `POST /send/text` for text;
- `POST /send/media` for image, video, audio/PTT, and document;
- the contact phone when valid, otherwise a stored UAZAPI `@lid` identity;
- `track_source: "wacrm"` and the local message id as `track_id` for diagnostics, not idempotency.

The UAZAPI contract explicitly allows duplicate tracking ids, so the client must not assume `track_id` prevents duplicate sends. It does not automatically retry a send after an ambiguous timeout or connection reset. Such a send is persisted as failed with an uncertainty-aware reason and requires an explicit resend.

### 3.3 Inbound boundary

Keep two public webhook entries:

- Meta: the existing `/api/whatsapp/webhook`, including Meta signature verification and payload parsing;
- UAZAPI: `/api/whatsapp/webhook/uazapi/[secret]`, using a high-entropy route secret because the supplied UAZAPI contract does not document webhook signatures or custom authentication headers.

Both routes normalize provider payloads into a shared envelope before invoking the existing CRM business processing. The envelope carries:

- provider and external message id;
- account/configuration identity;
- sender phone, provider external id, display name, and group flag;
- timestamp and direction;
- normalized content type, text/caption, MIME type, filename, and media locator;
- reply/interactive reference when available;
- message status or connection state for non-message events;
- the provider payload fields needed for diagnostics, excluding credentials.

The shared processor owns contact lookup/create, conversation lookup/create, message idempotency, unread counts, flow dispatch, automation dispatch, AI dispatch, notifications, and public webhook forwarding. Provider routes own authentication, provider schema parsing, and provider-specific media retrieval.

UAZAPI webhooks subscribe only to `messages`, `messages_update`, and `connection`, with `excludeMessages: ["wasSentByApi", "fromMeYes", "isGroupYes"]`. `addUrlEvents` and `addUrlTypesMessages` stay false so one stable endpoint accepts every subscribed event. Messages sent directly from the linked phone and groups are explicitly out of scope; the normalizer enforces both exclusions again if UAZAPI still delivers them.

For inbound media, use a supplied `fileURL` when available. If it is absent, call `POST /message/download` with `return_link: true` and `return_base64: false`. When `mirror_inbound_media` is enabled, mirror the media immediately because UAZAPI documents only two days of hosted retention. Fetches use timeouts, size limits, and MIME checks. When mirroring is disabled, the CRM stores the provider URL and accepts its expiry behavior, matching the existing setting's promise.

## 4. Data Model And Migration

Migration `043_uazapi_provider.sql` is additive and backfills all current behavior as Meta.

### 4.1 `whatsapp_config`

Add:

- `provider TEXT NOT NULL DEFAULT 'meta'`, constrained to `meta` or `uazapi`;
- `uazapi_instance_id TEXT` with a partial unique index;
- `uazapi_instance_name TEXT`;
- `uazapi_instance_token TEXT`, encrypted with the existing encryption helper;
- `uazapi_webhook_secret_hash TEXT` with a partial unique index; only the hash is stored;
- `connection_attempt_id UUID` for rejecting stale QR polling responses;
- `connected_phone TEXT`, `connected_name TEXT`, and `connected_avatar_url TEXT`;
- `last_connection_error TEXT` and `connection_checked_at TIMESTAMPTZ`.

Drop `NOT NULL` from Meta-only `phone_number_id` and `access_token`. Replace the current status constraint with `disconnected`, `connecting`, `connected`, `hibernated`, and `error`.

Add a provider-aware check constraint:

- Meta rows require `phone_number_id` and `access_token`; all UAZAPI credential and instance fields are null;
- UAZAPI rows require instance id, encrypted instance token, webhook secret hash, and connection attempt id; all Meta credential and identifier fields are null;
- transitional connection fields may be null until the remote provider returns them.

The existing unique `account_id` invariant remains. Existing rows receive `provider = 'meta'` and keep every current value.

### 4.2 Contact identities

Add `whatsapp_contact_identities` with `account_id`, `contact_id`, `provider`, `external_id`, `kind`, `created_at`, and `last_seen_at`. A unique key on `(account_id, provider, external_id)` prevents duplicate contacts for the same UAZAPI LID/JID.

Inbound lookup uses canonical phone first. When a UAZAPI event supplies both `sender_pn` and `sender_lid`, the existing phone contact is reused and the LID is attached. A later LID-only event resolves to that contact. The existing Meta BSUID columns and lookup remain unchanged; no risky historical backfill is required.

### 4.3 Messages

Add `messages.provider TEXT NOT NULL DEFAULT 'meta'`, constrained to the two providers. Backfill current rows to Meta. Replace external-message uniqueness from `(conversation_id, message_id)` to `(conversation_id, provider, message_id)`. Status event lookups include provider, preventing a UAZAPI id from updating an old Meta message after a provider switch.

### 4.4 Unsupported scheduled work

Extend broadcast status with `cancelled` and add a nullable cancellation reason. A switch from Meta to UAZAPI cancels scheduled or resumable broadcasts with reason `provider_switched`; rows and recipient history are retained.

Active automations containing `send_template` are deactivated during the switch. Active flows containing message nodes unsupported by UAZAPI are moved back to draft, and their active runs are stopped through the existing terminal run-state mechanism. Text/media-only automations and flows remain active. The switch response reports the affected counts so Settings can show an accurate notice.

### 4.5 Webhook quarantine

Add a service-role-only `whatsapp_webhook_quarantine` table for contract mismatches. Store provider, account/config ids, reason code, event name, a SHA-256 payload fingerprint, a sanitized and 64 KiB-limited JSON snapshot, first/last seen timestamps, occurrence count, and `expires_at` seven days after the latest occurrence.

There are no browser RLS policies. Repeated identical failures increment the existing row. A shared purge helper runs at most once per day from both existing authenticated cron routes and opportunistically on quarantine writes, so records are removed even when the affected account stops producing webhooks. Tokens, authorization values, QR data, binary/base64 content, and media bodies are always redacted.

## 5. Settings And QR Lifecycle

Settings presents Meta and UAZAPI as a segmented provider choice within the existing WhatsApp connection section.

The UAZAPI installation is available only when all of these server variables are valid:

- `UAZAPI_ENABLED=true`;
- `UAZAPI_BASE_URL`, normalized to HTTPS with no path or credentials;
- `UAZAPI_ADMIN_TOKEN`;
- `NEXT_PUBLIC_SITE_URL`, used as the canonical webhook origin.

If installation configuration is missing, the UAZAPI choice is visible but disabled with an operator-facing reason that does not name or expose secret values.

### 5.1 Start or resume

1. The user selects UAZAPI and confirms the destructive provider switch. CRM history remains.
2. The server calls `POST /instance/create` with the installation `admintoken`. The instance name is deterministic from the account id plus a random suffix and contains no user name, phone, or email.
3. The server encrypts the returned instance token and generates the route secret plus `connection_attempt_id` in memory. It does not replace the current configuration yet.
4. With the instance token, it configures `POST /webhook`. If webhook setup fails, it deletes the newly created instance as compensation and leaves the old Meta configuration untouched.
5. In one database transaction, it cancels/deactivates incompatible scheduled work and replaces the account configuration with the UAZAPI row in `connecting` state. If the transaction fails, it deletes the remote instance as compensation.
6. It calls `POST /instance/connect` without a phone and returns only QR image data, connection state, expiry, and `connection_attempt_id` to the authenticated browser. If this call fails, the UAZAPI row remains in a recoverable error state and the same instance can be retried.
7. The browser polls the account-scoped status endpoint every three seconds. Polling stops on connection, terminal error, page hide, or after two minutes.

QR data is never persisted in the database or logs. The server accepts documented raw base64 or data-URL forms and returns a normalized image data URL. An expired QR exposes **Generate new QR code**; this calls `/instance/connect` on the existing instance and rotates `connection_attempt_id`, rather than creating another instance.

Reloading Settings resumes polling for a configuration in `connecting`. `/instance/status` is authoritative for UAZAPI state. On `connected`, the CRM stores the available owner phone, profile name, and avatar URL.

### 5.2 Disconnect and switch

All switch and lifecycle commands are account-scoped, authenticated, and idempotent in the CRM.

- Removing UAZAPI calls `POST /instance/disconnect`, then `DELETE /instance`. A 404 is treated as already removed. The database row is removed only after remote removal succeeds or is confirmed absent.
- Switching from UAZAPI to Meta validates the submitted Meta identifiers and token first. It then disconnects UAZAPI but keeps the instance until Meta registration succeeds. On Meta failure, the UAZAPI row remains in disconnected state and can generate a new QR. On success, the server deletes the UAZAPI instance and replaces the row with Meta.
- Switching from Meta to UAZAPI leaves Meta untouched until UAZAPI instance creation and webhook registration succeed. The provider row changes to UAZAPI before QR display, so only one provider is active during pairing.
- Duplicate create/connect/disconnect requests return the current state or continue the incomplete step instead of creating parallel instances.

## 6. Capability Gating In The Product

The dashboard loads an account capability snapshot once and exposes it through a React provider around `DashboardShellInner`. It refreshes after provider connection, removal, or switch. Existing accounts with no saved provider retain the Meta-default product behavior, while provider-sensitive controls fail closed during the initial capability load so a UAZAPI account cannot click a Meta action during hydration. The UI uses this snapshot consistently:

- the global **Broadcasts** sidebar row stays visible but is disabled and cannot navigate under UAZAPI;
- dashboard quick actions that start a broadcast are disabled;
- Settings **Models/Templates** remains visible but disabled;
- **Synchronize with Meta** is disabled;
- the Inbox template picker is disabled;
- template automation actions and unsupported flow nodes are disabled in their builders;
- the Meta 24-hour service-window lock is applied only when the selected provider has that capability;
- supported text/media actions remain available.

Disabled controls use `aria-disabled`, do not attach navigation/click behavior, retain keyboard-safe focus behavior where a tooltip is needed, and explain: `Available only with the official Meta API` in the active locale. They are not merely dimmed links.

UI gating is not an authorization boundary. Direct page entry redirects to a safe relevant page with a provider notice. Template, template sync, broadcast, automation-save, flow-save, and send APIs assert capabilities server-side before performing reads that expose Meta-only state or writes that create work. Unsupported calls return HTTP 409 with a stable body:

```json
{
  "error": "provider_not_supported",
  "provider": "uazapi",
  "capability": "templates"
}
```

Switching back to Meta re-enables these surfaces automatically. Saved templates, completed broadcasts, contacts, conversations, and messages are never deleted.

## 7. Errors, Security, And Observability

### 7.1 UAZAPI HTTP behavior

The client has one request helper that:

- sends `admintoken` only to instance creation/admin operations and instance `token` only to that instance's endpoints;
- enforces HTTPS, request timeout, JSON content type, and response-size limits;
- parses success and error bodies with runtime guards rather than unchecked casts;
- maps 401/403 to authentication/configuration errors, 404 to missing instance/resource, 409/429 to retryable state conflicts, and 5xx/network failures to upstream-unavailable errors;
- redacts headers, tokens, QR data, base64, and media data from logs.

Retries are allowed only for idempotent reads and explicitly idempotent lifecycle reconciliation. Message sends are not automatically retried after ambiguous transport failure.

### 7.2 Webhook responses

- Unknown route secret: 404, with no indication that an account exists.
- Oversized or non-JSON body: 400/413 before business processing.
- Valid secret but unknown event/schema: sanitize, quarantine, log the fingerprint, and return 200 to stop infinite delivery retries.
- Duplicate recognized message/status: return 200 after idempotent no-op.
- Transient CRM database/storage failure: return 503 so UAZAPI may retry.
- Permanent content incompatibility after account resolution: quarantine and return 200.

When an event includes an instance identifier, it must match the configuration selected by the secret. Connection events update only lifecycle state. Outbound-message echoes are filtered at UAZAPI configuration and defensively rejected by the normalizer to prevent automation loops.

### 7.3 Operational diagnostics

Structured logs include provider, account id, configuration id, operation, HTTP status, external message id when safe, duration, and payload fingerprint. They never include message bodies or credentials. Settings surfaces a concise current-state error; detailed upstream messages stay server-side. UAZAPI's `/webhook/errors` endpoint may be queried by a server-side diagnostic action later, but no diagnostic UI is part of v1.

## 8. Testing Strategy

There is no UAZAPI test installation for this implementation. Verification therefore combines contract fixtures, fault injection, existing Meta regression tests, and a documented production smoke test that can be run later with a disposable number.

### 8.1 Unit tests

- capability matrix and `provider_not_supported` assertions;
- provider resolution and token decryption isolation;
- UAZAPI request headers, URL construction, timeouts, error mapping, and redaction;
- text/media request mapping and no retry on ambiguous sends;
- UAZAPI normalizer fixtures for text, image, video, audio, document, message status, connection state, phone plus LID, LID-only, self-sent, group, malformed, and unknown events;
- contact identity linking and provider-aware message idempotency;
- QR normalization, expiry, and stale `connection_attempt_id` handling.

Fixtures are derived from the supplied OpenAPI component schemas and documented examples. Because the generic webhook schema leaves `data` open-ended and uses event naming inconsistently, fixtures cover both documented top-level naming variants through explicit runtime guards; guessed fields are never silently treated as valid messages.

### 8.2 Route and service tests

- instance create, webhook setup, QR connect, status, refresh, disconnect, delete, and compensation paths with mocked UAZAPI responses;
- authenticated account isolation and webhook-secret hash lookup;
- 200 quarantine behavior, 503 transient behavior, duplicate delivery behavior, and size limits;
- inbound text/media persistence through the same CRM processor as Meta;
- media mirror enabled/disabled behavior and UAZAPI download fallback;
- provider switch success/failure recovery and cleanup;
- cancellation/deactivation of incompatible scheduled work;
- server gating for every Meta-only route, including public broadcast APIs;
- existing Meta config, send, webhook, templates, flow, automation, and broadcast tests remain green.

### 8.3 Component and browser tests

- Meta and UAZAPI Settings states, QR expiry/regeneration, reload resume, connected, hibernated, and error views;
- disabled sidebar, quick action, settings item, sync action, composer template control, automation action, and unsupported flow nodes;
- disabled controls do not navigate or execute through mouse or keyboard;
- desktop and mobile screenshots confirm no overlap and a scannable QR at practical phone-camera size;
- switching back to Meta restores capability-controlled UI.

### 8.4 Verification commands

Run the repository's test suite, focused new Vitest files, typecheck, lint, and production build. The implementation is not described as live-UAZAPI verified until an operator completes the smoke test below.

### 8.5 Deferred live smoke test

With a disposable WhatsApp number and a configured UAZAPI installation:

1. create an instance, scan the QR, reload Settings, and verify connected identity;
2. receive and send text plus each supported media type;
3. verify sent/delivered/read status progression where emitted;
4. verify a text automation and text/media flow;
5. verify Meta-only controls and direct APIs are blocked;
6. disconnect, reconnect with a fresh QR, then switch to Meta and back;
7. inspect UAZAPI webhook errors and CRM quarantine for zero unexplained events.

## 9. Acceptance Criteria

- Every pre-migration Meta account remains selected as Meta and retains current behavior.
- An account can select UAZAPI, scan a QR in Settings, resume pairing after reload, and see connection state without receiving any UAZAPI credential in the browser.
- One-to-one inbound/outbound text and supported media use the existing contact, conversation, Inbox, automation, and flow persistence model.
- Phone/LID changes do not create duplicate contacts when UAZAPI supplies enough identity information to link them.
- Provider message ids cannot collide across a provider switch.
- Models/templates, synchronization, broadcasts, template automation steps, and unsupported flow nodes are visibly and functionally disabled under UAZAPI, including direct API access.
- Existing incompatible scheduled work cannot send unexpectedly after a provider switch.
- Unknown UAZAPI webhook payloads neither trigger business actions nor retry forever; they leave a redacted, expiring diagnostic record.
- Meta regression tests, new contract tests, typecheck, lint, and build pass.
- Documentation and release notes clearly state that live UAZAPI behavior remains pending the operator smoke test when no test installation is available.
