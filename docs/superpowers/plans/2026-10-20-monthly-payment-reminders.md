# Monthly Payment Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-managed monthly payment reminder module that sends one short, automatic WhatsApp message per customer and competence at the configured São Paulo date and time.

**Architecture:** A dedicated Postgres-backed module stores recurring configurations and immutable delivery attempts. Pure TypeScript owns validation, calendar calculation and copy; authenticated Next.js routes own CRUD; a concurrency-safe runner claims due deliveries and sends through the existing WhatsApp provider layer; a one-minute scheduler starts from Next instrumentation.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Supabase/Postgres/RLS, Vitest, next-intl, existing WhatsApp provider transport and UI components.

**Spec:** `docs/superpowers/specs/2026-10-20-monthly-payment-reminders-design.md`

## Global Constraints

- Use `America/Sao_Paulo` for every due-date calculation; never inherit the host timezone.
- Store money as positive integer cents and format it with `pt-BR`/`BRL` at send time.
- Send exactly one automatic delivery per `(reminder_id, competence)`.
- Day 29, 30 or 31 falls on the last valid day of a shorter month.
- A reminder remains recurring until paused or soft-deleted; there is no end date.
- Support either one CRM contact or one manually entered name/phone pair.
- The outgoing copy is fixed and starts with `🤖 *Mensagem automática*`.
- Only `owner` and `admin` may read or mutate this module.
- Do not add a new runtime dependency for timezone handling.
- Keep the official Meta 24-hour limitation visible; this version does not create WhatsApp templates.

## Review Focus

- A reminder created or reactivated after this month's scheduled instant must not send immediately; it starts next month. Task 1 pins this rule.
- Editing a reminder after its current competence was sent must not create another delivery. Tasks 2 and 3 pin uniqueness and update behavior.
- A failed delivery from a previous competence must not be sent beside the new month's reminder; retries are limited to their own competence window. Tasks 2 and 4 pin expiry behavior.
- Contact deletion or a blank/invalid phone at execution time must produce a visible failure without falling back to stale recipient data. Task 4 pins this behavior.
- Two application instances claiming at the same instant must yield one sender, including recovery of a stale `processing` claim. Tasks 2 and 4 pin this behavior.

---

## File map

- `supabase/migrations/058_monthly_payment_reminders.sql`: tables, constraints, RLS, indexes, lease row and atomic claim RPC.
- `src/lib/monthly-payments/types.ts`: shared domain and persistence types.
- `src/lib/monthly-payments/schedule.ts`: São Paulo calendar and next-run calculations.
- `src/lib/monthly-payments/message.ts`: fixed Portuguese reminder copy.
- `src/lib/monthly-payments/validate.ts`: request validation and phone/money normalization.
- `src/lib/monthly-payments/repository.ts`: account-scoped CRUD and delivery queries.
- `src/lib/monthly-payments/runner.ts`: claim, recipient resolution, send and outcome recording.
- `src/lib/monthly-payments/scheduler.ts`: minute loop and database lease.
- `src/app/api/monthly-payments/**/route.ts`: authenticated management, test and cron endpoints.
- `src/app/(dashboard)/monthly-payments/page.tsx`: protected page shell.
- `src/app/(dashboard)/monthly-payments/monthly-payments-client.tsx`: list, form, history and actions.
- `src/components/layout/sidebar.tsx`: admin-only navigation entry.
- `src/instrumentation.ts`: scheduler startup.
- `messages/{pt,en,es,ko}.json`: UI translations.
- `.env.local.example`, `docs/monthly-payments.md`: operations documentation.

### Task 1: Domain rules and fixed message

**Files:**
- Create: `src/lib/monthly-payments/types.ts`
- Create: `src/lib/monthly-payments/schedule.ts`
- Create: `src/lib/monthly-payments/schedule.test.ts`
- Create: `src/lib/monthly-payments/message.ts`
- Create: `src/lib/monthly-payments/message.test.ts`
- Create: `src/lib/monthly-payments/validate.ts`
- Create: `src/lib/monthly-payments/validate.test.ts`

**Interfaces:**
- Produces: `MonthlyPaymentReminder`, `MonthlyPaymentDelivery`, `RecipientInput`, `ReminderInput` types.
- Produces: `scheduledInstant(input: { year: number; month: number; sendDay: number; sendTime: string; timeZone: string }): Date`, with `month` defined as 1–12.
- Produces: `firstEligibleCompetence(input: { now: Date; sendDay: number; sendTime: string; timeZone: string }): string` returning `YYYY-MM-01`.
- Produces: `nextScheduledInstant(input: ReminderScheduleInput & { after: Date; startsAt: Date }): Date`.
- Produces: `buildMonthlyPaymentMessage({ recipientName, competence, amountCents, currency }): string`.
- Produces: `parseReminderInput(raw: unknown): ReminderInput`, throwing `ReminderValidationError` with a user-safe message.

- [ ] **Step 1: Write failing schedule tests**

Cover `31 January -> 28 February 2027`, leap-year `29 February 2028`, exact `09:00 America/Sao_Paulo`, creation before the due instant using the current competence, creation after it using the next competence, and host-timezone independence.

- [ ] **Step 2: Run schedule tests and verify the new module is missing**

Run: `npx vitest run src/lib/monthly-payments/schedule.test.ts`
Expected: FAIL because `schedule.ts` does not exist.

- [ ] **Step 3: Implement the schedule interfaces**

Use `Intl.DateTimeFormat(...).formatToParts()` to resolve IANA-zone calendar parts without adding a dependency. Validate `sendTime` as `HH:mm` and cap `sendDay` to the month's actual last day.

- [ ] **Step 4: Write failing message and validation tests**

Assert the exact three-line copy for João, October 2026 and `50000` BRL cents. Cover contact recipient, manual recipient, missing manual name, malformed phone, zero/negative amount, fractional cent input, day outside 1–31 and malformed time.

- [ ] **Step 5: Implement message and validation interfaces**

Reuse the project's phone normalization conventions. The parser must accept only one recipient mode and must not trust client-provided `account_id`, `created_by`, timezone or currency.

- [ ] **Step 6: Run the domain tests**

Run: `npx vitest run src/lib/monthly-payments/schedule.test.ts src/lib/monthly-payments/message.test.ts src/lib/monthly-payments/validate.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/monthly-payments
git commit -m "feat: add monthly payment reminder rules"
```

### Task 2: Database schema and atomic delivery claims

**Files:**
- Create: `supabase/migrations/058_monthly_payment_reminders.sql`
- Create: `src/lib/monthly-payments/claim-contract.test.ts`

**Interfaces:**
- Consumes: competence format and statuses from Task 1.
- Produces: `monthly_payment_reminders`, `monthly_payment_deliveries`, `monthly_payment_scheduler_lease`.
- Produces RPC: `claim_due_monthly_payment_deliveries(p_now timestamptz, p_limit integer, p_holder text)` returning delivery id, reminder id, account id and competence.

- [ ] **Step 1: Write a failing migration contract test**

Assert the migration contains positive-cent/day/time/recipient checks, soft delete, RLS, admin select policies, unique `(reminder_id, competence)`, `FOR UPDATE SKIP LOCKED`, stale-processing recovery, current-competence filtering and an atomic lease update.

- [ ] **Step 2: Run the contract test and verify failure**

Run: `npx vitest run src/lib/monthly-payments/claim-contract.test.ts`
Expected: FAIL because migration 058 does not exist.

- [ ] **Step 3: Implement migration 058**

The schema uses `recipient_kind IN ('contact','manual')`. A contact reminder may retain its kind after `contact_id` becomes null through `ON DELETE SET NULL`, so the runner can report the deletion instead of silently using snapshot data; a manual reminder requires name and phone. The claim RPC must create the current competence only when its scheduled instant is due and `starts_at` permits it, then claim at most `p_limit` eligible rows. Failed rows retry no more than once per hour and stop being eligible when the next competence begins. A stale `processing_at` older than ten minutes is reclaimable. Security-definer functions use a fixed `search_path`; revoke execution from `PUBLIC`, `anon` and `authenticated`, and grant it only to `service_role`.

- [ ] **Step 4: Run migration contract and schema verification**

Run: `npx vitest run src/lib/monthly-payments/claim-contract.test.ts`
Expected: PASS.

If a local Supabase/Postgres instance is available, also run the repository's schema verification workflow. Otherwise record that database replay remains an external verification item.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/058_monthly_payment_reminders.sql src/lib/monthly-payments/claim-contract.test.ts
git commit -m "feat: add monthly payment reminder schema"
```

### Task 3: Account-scoped repository and CRUD API

**Files:**
- Create: `src/lib/monthly-payments/repository.ts`
- Create: `src/lib/monthly-payments/repository.test.ts`
- Create: `src/app/api/monthly-payments/route.ts`
- Create: `src/app/api/monthly-payments/[id]/route.ts`
- Create: `src/app/api/monthly-payments/[id]/deliveries/route.ts`
- Create: `src/app/api/monthly-payments/routes.test.ts`

**Interfaces:**
- Consumes: `ReminderInput`, schedule helpers and database schema from Tasks 1–2.
- Produces: `listReminders(db, accountId)`, `createReminder(db, context, input)`, `updateReminder(db, context, id, input)`, `setReminderEnabled(db, context, id, enabled)`, `softDeleteReminder(db, accountId, id)` and `listDeliveries(db, accountId, reminderId, limit)`.
- Produces authenticated JSON routes from the spec. `GET /api/monthly-payments` returns `{ reminders, contacts, whatsapp_provider }`, where contacts are limited to the caller's account and expose only `id`, `name` and `phone`.

- [ ] **Step 1: Write failing repository tests**

Use the project's fake Supabase-query pattern. Assert every query filters `account_id`; contact lookup verifies ownership; manual recipients persist normalized phone; pause preserves schedule; reactivation refreshes `starts_at`; update does not touch sent deliveries; delete sets `deleted_at` and disables the reminder.

- [ ] **Step 2: Run repository tests and verify failure**

Run: `npx vitest run src/lib/monthly-payments/repository.test.ts`
Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the repository interfaces**

List results include the latest delivery and the next scheduled instant. Never return rows from another account and never hard-delete delivery history.

- [ ] **Step 4: Write failing route tests**

Assert viewer/agent rejection, admin success, invalid-body `400`, missing row `404`, and account isolation for list, create, update, pause/reactivate, soft delete and history.

- [ ] **Step 5: Implement CRUD and history routes**

Use `requireRole('admin')`, `toErrorResponse`, `supabaseAdmin()` and the repository only. Route files export HTTP handlers and supported Next route constants only.

- [ ] **Step 6: Run repository and route tests**

Run: `npx vitest run src/lib/monthly-payments/repository.test.ts src/app/api/monthly-payments/routes.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/monthly-payments/repository.ts src/lib/monthly-payments/repository.test.ts src/app/api/monthly-payments
git commit -m "feat: add monthly payment reminder API"
```

### Task 4: Delivery runner and test-send endpoint

**Files:**
- Create: `src/lib/monthly-payments/runner.ts`
- Create: `src/lib/monthly-payments/runner.test.ts`
- Create: `src/app/api/monthly-payments/[id]/test/route.ts`

**Interfaces:**
- Consumes: claim RPC, repository types and fixed message from Tasks 1–3.
- Produces: `runMonthlyPaymentDeliveries(db, options?, deps?): Promise<{ claimed: number; sent: number; failed: number }>`.
- Produces: `sendMonthlyPaymentMessage(input, deps?): Promise<{ providerMessageId?: string }>` shared by scheduled and test sends.

- [ ] **Step 1: Write failing runner tests**

Cover contact resolution at execution time, conversation-backed `engineSendText`, direct provider send for a manual number, exact message copy, sent outcome, safe failed outcome, missing/deleted contact, invalid live phone, no fallback to stored contact data, stale claim recovery contract, one sender for duplicate claims and refusal to process a previous competence after its window closes.

- [ ] **Step 2: Run runner tests and verify failure**

Run: `npx vitest run src/lib/monthly-payments/runner.test.ts`
Expected: FAIL because `runner.ts` does not exist.

- [ ] **Step 3: Implement runner and sender**

Inject claim/send/time dependencies for tests. For CRM contacts use `resolveConversationByPhone` plus `engineSendText`; for manual numbers use `loadProviderTransport`. Persist the effective name, phone and text on the delivery before/with the outcome. Sanitize provider errors to 500 characters.

- [ ] **Step 4: Write failing test-send route tests**

Assert admin authorization, same-account reminder lookup, immediate send, no insert/update in `monthly_payment_deliveries`, and provider errors returned as a user-safe non-2xx response.

- [ ] **Step 5: Implement `POST /api/monthly-payments/[id]/test`**

Load the current reminder/recipient, build the current-month preview and call the shared sender with a test-specific tracking id.

- [ ] **Step 6: Run delivery tests**

Run: `npx vitest run src/lib/monthly-payments/runner.test.ts src/app/api/monthly-payments/routes.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/monthly-payments/runner.ts src/lib/monthly-payments/runner.test.ts src/app/api/monthly-payments
git commit -m "feat: send scheduled monthly payment reminders"
```

### Task 5: Scheduler, external cron and server startup

**Files:**
- Create: `src/lib/monthly-payments/scheduler.ts`
- Create: `src/lib/monthly-payments/scheduler.test.ts`
- Create: `src/app/api/monthly-payments/cron/route.ts`
- Create: `src/app/api/monthly-payments/cron/route.test.ts`
- Modify: `src/instrumentation.ts`

**Interfaces:**
- Consumes: `runMonthlyPaymentDeliveries` from Task 4 and lease table from Task 2.
- Produces: `acquireMonthlyPaymentSchedulerLease(db, holder, now?, leaseMs?): Promise<boolean>`.
- Produces: `startMonthlyPaymentScheduler(env?): boolean` and `resetMonthlyPaymentSchedulerForTests(): void`.

- [ ] **Step 1: Write failing scheduler tests**

Assert disabled via `MONTHLY_PAYMENTS_AUTORUN=false`, disabled without Supabase server credentials, one start per process, one-minute interval, delayed first tick, conditional lease acquisition and swallowed/logged cycle failures.

- [ ] **Step 2: Run scheduler tests and verify failure**

Run: `npx vitest run src/lib/monthly-payments/scheduler.test.ts`
Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement scheduler and wire instrumentation**

Start only in Node runtime and outside production build. Preserve the existing ads scheduler startup. Use unref'd timers and a lease longer than one normal batch but short enough for crash recovery.

- [ ] **Step 4: Write and implement cron route tests**

Assert bearer-secret validation using `MONTHLY_PAYMENTS_CRON_SECRET`, missing configuration failure, successful runner result, and no logged secret. Implement `POST /api/monthly-payments/cron`.

- [ ] **Step 5: Run scheduler, cron and instrumentation-related tests**

Run: `npx vitest run src/lib/monthly-payments/scheduler.test.ts src/app/api/monthly-payments/cron/route.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/monthly-payments/scheduler.ts src/lib/monthly-payments/scheduler.test.ts src/app/api/monthly-payments/cron src/instrumentation.ts
git commit -m "feat: schedule monthly payment reminders"
```

### Task 6: Monthly payments page and navigation

**Files:**
- Create: `src/app/(dashboard)/monthly-payments/page.tsx`
- Create: `src/app/(dashboard)/monthly-payments/monthly-payments-client.tsx`
- Create: `src/app/(dashboard)/monthly-payments/monthly-payments-client.test.tsx`
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `messages/pt.json`
- Modify: `messages/en.json`
- Modify: `messages/es.json`
- Modify: `messages/ko.json`

**Interfaces:**
- Consumes: CRUD, history and test routes from Tasks 3–4.
- Produces: `/monthly-payments` admin page with list, create/edit form, pause/reactivate/delete, history and test-send feedback.

- [ ] **Step 1: Write failing UI behavior tests**

Cover empty/loading/error states, contact/manual recipient switch, amount/day/time validation, exact preview copy, create/edit submit, pause/reactivate, destructive confirmation, test send, last status/error, next-send display, Meta-provider warning and mobile-accessible labels.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npx vitest run src/app/\(dashboard\)/monthly-payments/monthly-payments-client.test.tsx`
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement the protected page and client UI**

Follow the existing ads-monitor/settings patterns and UI primitives. Populate the selector from the account-scoped `contacts` array returned by `GET /api/monthly-payments`; do not create a second all-contact endpoint. Show BRL preview before save and use `09:00` as the new-form default.

- [ ] **Step 4: Add admin-only sidebar navigation and translations**

Use a suitable Lucide calendar/payment icon, `minRole: 'admin'`, and translation key `Sidebar.monthlyPayments`. Add all page strings to four catalogs without reserializing unrelated JSON.

- [ ] **Step 5: Run UI, i18n and role-visibility tests**

Run: `npx vitest run src/app/\(dashboard\)/monthly-payments/monthly-payments-client.test.tsx src/i18n/messages.test.ts src/i18n/icu-safety.test.ts src/lib/auth/roles-visibility.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(dashboard\)/monthly-payments src/components/layout/sidebar.tsx messages
git commit -m "feat: add monthly payments management page"
```

### Task 7: Operations documentation and installation bundle

**Files:**
- Create: `docs/monthly-payments.md`
- Modify: `.env.local.example`
- Modify: `README.md`
- Regenerate: `supabase/instalacao/parte-*.sql` as selected by `scripts/gerar-sql-instalacao.mjs`

**Interfaces:**
- Consumes: completed module behavior from Tasks 1–6.
- Produces: operator setup, provider limitation, environment flags, migration order and recovery instructions.

- [ ] **Step 1: Document installation and operation**

Describe migration 058, `MONTHLY_PAYMENTS_AUTORUN`, `MONTHLY_PAYMENTS_CRON_SECRET`, internal-vs-external scheduler choice, UAZAPI behavior, official Meta 24-hour restriction, test send, retry status and pause semantics.

- [ ] **Step 2: Update the environment example and README**

Add commented settings without real secrets and add Monthly Payments to the feature/documentation lists.

- [ ] **Step 3: Regenerate installation SQL**

Run: `node scripts/gerar-sql-instalacao.mjs`
Expected: generated installation parts include migration 058 and the generator reports success.

- [ ] **Step 4: Verify documentation references and generated diff**

Run: `rg -n "MONTHLY_PAYMENTS|058_monthly_payment|Mensalidades" README.md .env.local.example docs supabase/instalacao`
Expected: every runtime setting and migration is discoverable; no references to removed Meta Lead Ads migration remain.

- [ ] **Step 5: Commit**

```bash
git add docs/monthly-payments.md .env.local.example README.md supabase/instalacao
git commit -m "docs: document monthly payment reminders"
```

### Task 8: Full verification and manual acceptance

**Files:**
- Modify only files required by failures found in this task.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a verified, deployable module and an explicit list of external checks still requiring real credentials.

- [ ] **Step 1: Run focused module tests**

Run: `npx vitest run src/lib/monthly-payments src/app/api/monthly-payments src/app/\(dashboard\)/monthly-payments`
Expected: all focused tests PASS.

- [ ] **Step 2: Run repository verification**

Run sequentially:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: every command exits `0`. If lint still traverses nested worktree build artifacts, narrow/fix repository ignores in a separate, clearly identified maintenance commit before rerunning.

- [ ] **Step 3: Perform visual acceptance**

Check desktop and mobile widths for list, form, empty state, errors, destructive confirmation and long names/amounts. Confirm keyboard labels and focus behavior.

- [ ] **Step 4: Perform database and live-send acceptance when credentials exist**

Apply migration 058 to a staging Supabase project. Create one contact reminder and one manual-number reminder scheduled a few minutes ahead, verify one delivery each, restart the server, verify no duplicate, pause and verify no next-month claim, then run test send. Record UAZAPI live-send evidence separately from unit tests.

- [ ] **Step 5: Review the final diff and commit verification fixes**

Run: `git status --short && git diff --check && git log --oneline -10`
Expected: only intentional changes, no whitespace errors and coherent task commits.

If verification required fixes:

```bash
git add <verified-fix-files>
git commit -m "fix: harden monthly payment reminders"
```
