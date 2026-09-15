-- ============================================================
-- CRM - BANCO DE DADOS - PARTE 4 DE 4
--
-- Cole ESTE arquivo inteiro no SQL Editor do Supabase e clique
-- em Run. Depois volte e faca o mesmo com a parte (acabou).
--
-- IMPORTANTE: rode as partes NA ORDEM, da 1 ate a 4.
--
-- Contem: 038_broadcast_resume.sql ate 045_uazapi_groups_and_history.sql
--
-- E seguro rodar de novo se voce se perder: tudo aqui usa
-- IF NOT EXISTS ou DROP ... IF EXISTS, entao repetir uma parte
-- nao apaga dados nem quebra nada.
-- ============================================================

-- ------------------------------------------------------------
-- 038_broadcast_resume.sql
-- ------------------------------------------------------------

-- ============================================================
-- 038_broadcast_resume
--
-- Issue #472. A dashboard campaign's send loop runs in the browser tab
-- that started it. Close the tab and the remaining recipients are
-- stranded 'pending' while the broadcast sits in 'sending' forever —
-- the "no campaign status is updated" half of that report. The
-- reporter also asked for a way to reprocess pending and failed
-- recipients. All three need delivery to be resumable server-side,
-- which needs two things the schema didn't record:
--
--   1. broadcast_recipients.template_params — the per-recipient
--      variable values. The wizard resolved them in the browser at
--      send time and never persisted them, so a later resume had no
--      way to reconstruct what {{1}} should be for each contact.
--      Freezing them at plan time also means a resume sends exactly
--      what the original pass would have, not a re-resolution against
--      contact data that may have changed since.
--
--   2. broadcasts.delivery_locked_at — a mutex. Resume is a button.
--      Two clicks, or a click while another pass is still fanning out,
--      would message people twice, and a WhatsApp message cannot be
--      recalled.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Per-recipient template params
-- ============================================================
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS template_params JSONB;

COMMENT ON COLUMN broadcast_recipients.template_params IS
  'Positional body values for this recipient''s template send ({{1}}, {{2}}, ...), frozen when the broadcast was planned. NULL on rows created before migration 038; a resume treats that as no params.';

-- ============================================================
-- 2. Delivery mutex
--
-- Claimed with a conditional UPDATE (`WHERE delivery_locked_at IS NULL
-- OR delivery_locked_at < cutoff`), which is atomic in one statement —
-- the loser's WHERE simply doesn't match. A lock older than the
-- staleness window is treated as abandoned, which is what recovers a
-- pass whose process died mid-fan-out.
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN broadcasts.delivery_locked_at IS
  'Set while a server-side delivery pass is fanning out; NULL when idle. See 038_broadcast_resume.sql.';

-- Resume selects this broadcast's pending / failed rows.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients(broadcast_id, status);

-- ============================================================
-- 3. create_broadcast_with_recipients — carry params through
--
-- Dropped rather than CREATE OR REPLACE'd: adding a parameter makes a
-- new overload, and a DEFAULT on it would leave the 7-argument call
-- ambiguous between the two.
-- ============================================================
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[]
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) TO service_role;


-- ------------------------------------------------------------
-- 039_inbound_media_mirror.sql
-- ------------------------------------------------------------

-- ============================================================
-- 039_inbound_media_mirror
--
-- Issue #466. Inbound media is never persisted. The webhook verifies
-- the Meta media id and stores a POINTER — `/api/whatsapp/media/<id>`
-- — and that route re-streams the bytes from Meta on every view. Meta
-- deletes media roughly 30 days after receipt, so every inbound photo,
-- voice note and document silently rots into "Photo unavailable". No
-- amount of UI can recover it; the bytes are simply gone.
--
-- Outbound media already survives: the composer uploads to the public
-- `chat-media` bucket (migration 023) and stores a durable URL. This
-- migration is the schema half of doing the same for inbound.
--
-- Three changes:
--
--   1. `messages.media_type` — the MIME type the webhook has always
--      had in hand and always discarded (`void mediaType` in
--      `webhook/route.ts`). Without it, a download has to guess the
--      file extension from the fetched blob, which only works once
--      the bytes have already been fetched successfully.
--
--   2. `whatsapp_config.mirror_inbound_media` — the per-account
--      opt-OUT. Mirroring every inbound attachment is unbounded
--      storage growth on a self-hosted Supabase project, so it has to
--      be switchable. It defaults to TRUE because the thing being
--      fixed is silent data loss: an account that never finds the
--      setting should be the one that keeps its attachments, not the
--      one that keeps losing them.
--
--   3. Widens the `chat-media` MIME allow-list with the types Meta can
--      hand us on the way IN but that we never send out — animated
--      GIFs, bare Opus, QuickTime video, and Meta's own `video/3gp`
--      spelling of `video/3gpp`. The bucket's allow-list is enforced
--      by Storage for the service role too, so without this an
--      inbound GIF is rejected at upload and falls back to the proxy
--      (i.e. still expires). The list mirrors the inbound-only types
--      already enumerated in `EXTENSION_BY_MIME`
--      (`src/lib/media/filename.ts`).
--
-- NO BACKFILL IS POSSIBLE. Media Meta has already expired cannot be
-- recovered, and media still inside the 30-day window would need the
-- account's access token, which is encrypted at rest and only
-- decryptable by the app. Existing rows keep their proxy URL and the
-- proxy route keeps serving them for as long as Meta still has them.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. messages.media_type
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_type TEXT;

COMMENT ON COLUMN messages.media_type IS
  'MIME type of media_url''s content, as reported by Meta. Populated for '
  'INBOUND media only: an outbound media_url is a chat-media object whose '
  'path already carries the original filename and extension, so the type '
  'adds nothing there. Also NULL for text messages and for every row '
  'written before migration 039.';

-- ============================================================
-- 2. whatsapp_config.mirror_inbound_media
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS mirror_inbound_media BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN whatsapp_config.mirror_inbound_media IS
  'When true (default), the inbound webhook copies received media into '
  'the chat-media bucket so it outlives Meta''s ~30-day retention. Turn '
  'off to keep storage flat and accept that attachments expire.';

-- ============================================================
-- 3. chat-media: allow the inbound-only MIME types
--
-- Same UPSERT shape as migration 023 so the two stay comparable. Only
-- the allowed_mime_types array changes; the bucket stays public with
-- the same 16 MB ceiling, and the storage RLS policies from 023 are
-- untouched (the webhook writes with the service role, which bypasses
-- them, but a bucket-level MIME rejection applies to it all the same).
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  TRUE,
  16777216, -- 16 MB, unchanged from 023
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp',
    -- Inbound-only: animated GIFs forwarded from another chat
    'image/gif',
    -- Videos
    'video/mp4', 'video/3gpp',
    -- Inbound-only: Meta's own spelling of 3gpp, and iOS clips that
    -- arrive as QuickTime rather than MP4
    'video/3gp', 'video/quicktime',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    -- Audio (voice notes) — outbound is transcoded to audio/ogg first
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr',
    -- Inbound-only: some clients label an Opus voice note audio/opus
    -- rather than audio/ogg
    'audio/opus'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ------------------------------------------------------------
-- 040_contact_business_scoped_user_id.sql
-- ------------------------------------------------------------

-- ============================================================
-- 040_contact_business_scoped_user_id
--
-- Give a contact a second identity: WhatsApp's business-scoped user ID
-- (BSUID) and username (issue #519).
--
-- Meta assigns every WhatsApp user a BSUID that is unique within one
-- business portfolio, and once a user adopts a username the message
-- webhook stops carrying their phone number at all — `messages[].from`
-- and `contacts[].wa_id` are both omitted, and only
-- `messages[].from_user_id` / `contacts[].user_id` identify the sender.
--
-- Before this migration those senders had no key to be found under.
-- `contacts.phone` resolved to '' for them, and the unique index from
-- migration 022 is partial (`WHERE phone_normalized <> ''`), so nothing
-- stopped a brand-new contact — and with it a brand-new conversation —
-- being inserted for every inbound message from the same person.
--
-- `phone` deliberately stays NOT NULL. A BSUID-only contact stores ''
-- there, which migration 022's partial index already tolerates and
-- which keeps `Contact.phone` a plain `string` in the app. The new
-- partial unique index below is what guarantees one row per BSUID.
--
-- Idempotent. Additive only — no existing row is modified and no
-- existing constraint changes.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_user_id TEXT,
  ADD COLUMN IF NOT EXISTS wa_parent_user_id TEXT,
  ADD COLUMN IF NOT EXISTS wa_username TEXT;

COMMENT ON COLUMN contacts.wa_user_id IS
  'WhatsApp business-scoped user ID (e.g. "US.13491208655302741918"). Stable per (user, business portfolio) and the primary inbound key when Meta withholds the phone number.';
COMMENT ON COLUMN contacts.wa_parent_user_id IS
  'Portfolio-level BSUID (e.g. "US.ENT.11815799212886844830"). Stored for reference; not used as a lookup key.';
COMMENT ON COLUMN contacts.wa_username IS
  'WhatsApp username, without the leading @. Display only — usernames are user-changeable and must never be used as an identity key.';

-- One contact per BSUID per account — the same guarantee migration 022
-- gave phone numbers. Partial so the millions of rows that will never
-- have a BSUID stay out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_user_id
  ON contacts (account_id, wa_user_id)
  WHERE wa_user_id IS NOT NULL;


-- ------------------------------------------------------------
-- 041_fix_broadcast_contact_id_ambiguity.sql
-- ------------------------------------------------------------

-- ============================================================
-- 041_fix_broadcast_contact_id_ambiguity.sql — make
--     create_broadcast_with_recipients executable
--
-- The problem
--
--   Every call to POST /api/v1/broadcasts dies in the database with
--   SQLSTATE 42702:
--
--     column reference "contact_id" is ambiguous
--     It could refer to either a PL/pgSQL variable or a table column.
--
--   `create_broadcast_with_recipients` is declared
--   `RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)`,
--   and in PL/pgSQL a RETURNS TABLE output column is ALSO an in-scope
--   variable. The recipient INSERT ends in a bare
--   `RETURNING id, contact_id`, so that `contact_id` resolves against
--   both the target table's column and the function's own output
--   variable, and Postgres refuses to guess. Qualifying it —
--   `broadcast_recipients.contact_id` — names the column and nothing
--   else. That one word is the entire fix.
--
--   The other identifiers in the body are already unambiguous:
--   `broadcast_id` appears only in an INSERT column list (never a
--   variable reference), and the final SELECT reads through `ins`.
--
-- Why nothing caught it
--
--   A plpgsql body is only parsed at CREATE time — name resolution
--   happens on first EXECUTION. The migration applies cleanly, so both
--   a fresh `supabase db reset` and CI go green on a function that
--   cannot run. Worth considering a smoke test that CALLS the RPCs the
--   migrations define, not just one that applies them.
--
--   The blast radius also hid it. `lib/whatsapp/broadcast-core.ts` is
--   the only caller, reached from the public API. The dashboard's own
--   broadcast route (POST /api/whatsapp/broadcast) loops
--   sendTemplateMessage and never writes a campaign row, so the UI
--   looks healthy while `broadcasts` and `broadcast_recipients` stay
--   empty.
--
-- Introduced by 037 (which added the function, fixing #370) and
-- carried forward unchanged by 038 (which added p_template_params,
-- fixing #472). It has never once succeeded.
--
-- Why a new file rather than an edit to 038
--
--   Applied migrations are recorded in `schema_migrations`, so editing
--   038 in place would fix only fresh installs — every existing
--   deployment already has 038 recorded and would keep the broken
--   function forever. Same reasoning, and the same shape, as
--   034_fix_profiles_update_rls.sql repairing 017's policy.
--
--   This is a CREATE OR REPLACE of the exact 038 signature, so it is
--   idempotent and safe to re-run. Signature, arguments and result
--   columns are unchanged — broadcast-core.ts needs no edit.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[]
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    -- Qualified: a bare `contact_id` collides with the RETURNS TABLE
    -- output variable of the same name. This is the whole fix.
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

-- CREATE OR REPLACE preserves the existing ACL, but 037/038 both state
-- the grants explicitly so a replay from nothing lands the same thing.
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]) TO service_role;


-- ------------------------------------------------------------
-- 042_message_failure_reason.sql
-- ------------------------------------------------------------

-- ============================================================
-- 042_message_failure_reason
--
-- Issue #535. When Meta cannot deliver an outbound message it posts a
-- `failed` status webhook whose `errors[0]` carries the reason — a
-- stable numeric `code` (131049 "per-user marketing limit", 131026
-- "undeliverable", 131047 "re-engagement window closed", ...), a short
-- `title`, and a human-readable `error_data.details`. The webhook
-- handler wrote only `status = 'failed'` and dropped the rest, so an
-- agent staring at a red X in the inbox had no way to tell a blocked
-- number from an expired template from an account-level cap.
--
-- Two changes:
--
--   1. `messages.error_code` / `error_title` / `error_details` — the
--      three pieces Meta sends, stored separately so the code stays
--      filterable and the details stay readable. All nullable: they are
--      only populated on a `failed` status and are deliberately NOT
--      cleared if a later non-failed status arrives for the same wamid
--      (rare, but Meta does not promise ordering), so the reason is
--      never lost to a race.
--
--   2. Nothing on `broadcast_recipients`. That table already has a
--      free-text `error_message` column (migration 001) which the
--      sender populates on synchronous API failures; the webhook now
--      writes "[code] title: details" into the same column for
--      asynchronous ones, so the broadcast detail page's existing
--      error column shows both without a schema change there.
--
-- No backfill is possible: the failure payloads that were already
-- received were discarded at the door.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code INTEGER,
  ADD COLUMN IF NOT EXISTS error_title TEXT,
  ADD COLUMN IF NOT EXISTS error_details TEXT;

COMMENT ON COLUMN messages.error_code IS
  'Meta''s numeric error code from a failed status webhook (errors[0].code). '
  'NULL unless the message failed. Not cleared by a later status update.';

COMMENT ON COLUMN messages.error_title IS
  'Meta''s short error label from a failed status webhook (errors[0].title). '
  'NULL unless the message failed.';

COMMENT ON COLUMN messages.error_details IS
  'Meta''s human-readable explanation from a failed status webhook '
  '(errors[0].error_data.details). NULL unless the message failed and Meta '
  'supplied details.';


-- ------------------------------------------------------------
-- 043_uazapi_provider.sql
-- ------------------------------------------------------------

-- ============================================================
-- 043_uazapi_provider
--
-- Add the provider-neutral data model used to run the existing Meta
-- integration beside UAZAPI. Defaults preserve all current rows as
-- Meta data, and whatsapp_config keeps its one-row-per-account key.
-- ============================================================

-- ============================================================
-- Provider-aware WhatsApp configuration
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret_hash TEXT,
  ADD COLUMN IF NOT EXISTS connection_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS connected_phone TEXT,
  ADD COLUMN IF NOT EXISTS connected_name TEXT,
  ADD COLUMN IF NOT EXISTS connected_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS last_connection_error TEXT,
  ADD COLUMN IF NOT EXISTS connection_checked_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('disconnected', 'connecting', 'connected', 'hibernated', 'error'));

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL
      AND uazapi_instance_id IS NULL
      AND uazapi_instance_name IS NULL
      AND uazapi_webhook_secret_hash IS NULL
      AND connection_attempt_id IS NULL)
    OR
    (provider = 'uazapi'
      AND phone_number_id IS NULL
      AND waba_id IS NULL
      AND access_token IS NULL
      AND verify_token IS NULL
      AND uazapi_instance_id IS NOT NULL
      AND uazapi_webhook_secret_hash IS NOT NULL
      AND connection_attempt_id IS NOT NULL)
  );

-- The browser can SELECT whatsapp_config through the account-member RLS
-- policy added in migration 017. Keep the single configuration row as
-- the source of provider state, but isolate its encrypted UAZAPI token in
-- a one-to-one table that has no browser policies. The format check matches
-- the AES-256-GCM ciphertext emitted by src/lib/whatsapp/encryption.ts:
-- 12-byte IV, non-empty ciphertext, and 16-byte authentication tag.
CREATE TABLE IF NOT EXISTS whatsapp_config_secrets (
  whatsapp_config_id UUID PRIMARY KEY REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  uazapi_instance_token TEXT NOT NULL,
  CONSTRAINT whatsapp_config_secrets_uazapi_instance_token_encrypted_check
    CHECK (uazapi_instance_token ~ '^[0-9A-Fa-f]{24}:[0-9A-Fa-f]+:[0-9A-Fa-f]{32}$')
);

ALTER TABLE whatsapp_config_secrets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE whatsapp_config_secrets IS
  'Server-only provider credentials for the account''s single whatsapp_config row.';
COMMENT ON COLUMN whatsapp_config_secrets.uazapi_instance_token IS
  'AES-256-GCM ciphertext produced by the server-side WhatsApp encryption helper; never plaintext.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance
  ON whatsapp_config(uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_webhook_hash
  ON whatsapp_config(uazapi_webhook_secret_hash)
  WHERE uazapi_webhook_secret_hash IS NOT NULL;

-- ============================================================
-- Provider-specific contact identities
--
-- No browser policies are created. Service-role webhook processing
-- owns all reads and writes to this table.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_contact_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'uazapi')),
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_contact_identities_contact
  ON whatsapp_contact_identities(account_id, contact_id);

ALTER TABLE whatsapp_contact_identities ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Provider-aware message identity
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_provider_check;
ALTER TABLE messages ADD CONSTRAINT messages_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

DROP INDEX IF EXISTS idx_messages_conversation_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_provider_message_id
  ON messages (conversation_id, provider, message_id);

-- ============================================================
-- Broadcast cancellation history
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- ============================================================
-- Sanitized webhook contract mismatches
--
-- No browser policies are created. Service-role webhook processing
-- writes and maintains these short-lived diagnostic rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_webhook_quarantine (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'uazapi')),
  reason_code TEXT NOT NULL,
  event_name TEXT,
  payload_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  UNIQUE (account_id, provider, reason_code, payload_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_quarantine_expires
  ON whatsapp_webhook_quarantine(expires_at);

ALTER TABLE whatsapp_webhook_quarantine ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 044_uazapi_provider_switch.sql
-- ------------------------------------------------------------

-- ============================================================
-- 044_uazapi_provider_switch
--
-- One transaction that moves an account from Meta to UAZAPI.
--
-- Split from 043 on purpose: 043 is the schema and may already be
-- applied in an environment, so it stays immutable. This migration adds
-- only the switch routine.
--
-- The routine stops the work UAZAPI cannot perform and replaces the
-- account's single whatsapp_config row. Nothing is deleted from history:
-- broadcasts are cancelled with a reason, automations are deactivated,
-- flows return to draft, and their active runs end. Switching back to
-- Meta re-enables the features; the rows are all still there.
--
-- The function receives only a ciphertext and a hash. The plaintext
-- instance token and the plaintext webhook secret never reach the
-- database, and the guards below refuse the call if they ever do.
-- ============================================================

CREATE OR REPLACE FUNCTION switch_account_to_uazapi(
  p_account_id UUID,
  p_user_id UUID,
  p_instance_id TEXT,
  p_instance_name TEXT,
  p_encrypted_instance_token TEXT,
  p_webhook_secret_hash TEXT,
  p_connection_attempt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_config_id UUID;
  v_cancelled_broadcasts INTEGER := 0;
  v_deactivated_automations INTEGER := 0;
  v_drafted_flows INTEGER := 0;
  v_stopped_flow_runs INTEGER := 0;
  v_incompatible_flows UUID[] := '{}'::UUID[];
BEGIN
  IF p_account_id IS NULL
     OR p_user_id IS NULL
     OR p_instance_id IS NULL
     OR p_encrypted_instance_token IS NULL
     OR p_webhook_secret_hash IS NULL
     OR p_connection_attempt_id IS NULL THEN
    RAISE EXCEPTION 'switch_account_to_uazapi requires every identity argument';
  END IF;

  -- Same AES-256-GCM shape the whatsapp_config_secrets constraint enforces.
  -- Checked here too so a bad call fails before anything is cancelled.
  IF p_encrypted_instance_token !~ '^[0-9A-Fa-f]{24}:[0-9A-Fa-f]+:[0-9A-Fa-f]{32}$' THEN
    RAISE EXCEPTION 'uazapi instance token must be encrypted before the provider switch';
  END IF;

  IF p_webhook_secret_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'uazapi webhook secret must be stored as a sha-256 hash';
  END IF;

  -- 1. Scheduled and in-flight broadcasts would otherwise keep sending
  --    Meta templates through a provider that has none.
  WITH cancelled AS (
    UPDATE broadcasts
       SET status = 'cancelled',
           cancellation_reason = 'provider_switched',
           updated_at = NOW()
     WHERE account_id = p_account_id
       AND status IN ('scheduled', 'sending')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_cancelled_broadcasts FROM cancelled;

  -- 2. Automations that send a template. Text/media automations keep running.
  WITH deactivated AS (
    UPDATE automations a
       SET is_active = FALSE,
           updated_at = NOW()
     WHERE a.account_id = p_account_id
       AND a.is_active
       AND EXISTS (
         SELECT 1 FROM automation_steps s
          WHERE s.automation_id = a.id
            AND s.step_type = 'send_template'
       )
    RETURNING a.id
  )
  SELECT COUNT(*) INTO v_deactivated_automations FROM deactivated;

  -- 3. Flows with interactive nodes go back to draft so they cannot be
  --    triggered, while remaining fully editable.
  WITH drafted AS (
    UPDATE flows f
       SET status = 'draft',
           updated_at = NOW()
     WHERE f.account_id = p_account_id
       AND f.status = 'active'
       AND EXISTS (
         SELECT 1 FROM flow_nodes n
          WHERE n.flow_id = f.id
            AND n.node_type IN ('send_buttons', 'send_list')
       )
    RETURNING f.id
  )
  SELECT COUNT(*), COALESCE(ARRAY_AGG(id), '{}'::UUID[])
    INTO v_drafted_flows, v_incompatible_flows
    FROM drafted;

  -- 4. A run waiting on a button reply can never advance now, so it ends
  --    through the existing terminal run state.
  IF COALESCE(ARRAY_LENGTH(v_incompatible_flows, 1), 0) > 0 THEN
    WITH stopped AS (
      UPDATE flow_runs
         SET status = 'failed',
             end_reason = 'provider_switched',
             ended_at = NOW()
       WHERE account_id = p_account_id
         AND status = 'active'
         AND flow_id = ANY (v_incompatible_flows)
      RETURNING id
    )
    SELECT COUNT(*) INTO v_stopped_flow_runs FROM stopped;
  END IF;

  -- 5. Replace the single configuration row. Deleting first keeps the
  --    provider-fields check satisfied at every step and cascades the old
  --    secret away; contacts, conversations and messages are untouched.
  DELETE FROM whatsapp_config WHERE account_id = p_account_id;

  INSERT INTO whatsapp_config (
    account_id,
    user_id,
    provider,
    status,
    uazapi_instance_id,
    uazapi_instance_name,
    uazapi_webhook_secret_hash,
    connection_attempt_id,
    created_at,
    updated_at
  ) VALUES (
    p_account_id,
    p_user_id,
    'uazapi',
    'connecting',
    p_instance_id,
    p_instance_name,
    p_webhook_secret_hash,
    p_connection_attempt_id,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_config_id;

  INSERT INTO whatsapp_config_secrets (whatsapp_config_id, uazapi_instance_token)
  VALUES (v_config_id, p_encrypted_instance_token);

  RETURN JSONB_BUILD_OBJECT(
    'config_id', v_config_id,
    'cancelled_broadcasts', v_cancelled_broadcasts,
    'deactivated_automations', v_deactivated_automations,
    'drafted_flows', v_drafted_flows,
    'stopped_flow_runs', v_stopped_flow_runs
  );
END;
$$;

COMMENT ON FUNCTION switch_account_to_uazapi(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) IS
  'Transactionally switches an account to UAZAPI: cancels incompatible scheduled work and replaces the single whatsapp_config row. Accepts only an encrypted instance token and a hashed webhook secret.';

-- Only the server may run this. It writes credentials and cancels work,
-- so no browser role keeps the default PUBLIC execute grant.
REVOKE ALL ON FUNCTION switch_account_to_uazapi(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION switch_account_to_uazapi(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role';
  END IF;
END
$$;


-- ------------------------------------------------------------
-- 045_uazapi_groups_and_history.sql
-- ------------------------------------------------------------

-- ============================================================
-- 045_uazapi_groups_and_history
--
-- Widen the inbox so a salesperson sees the whole picture: group
-- threads, messages sent from the linked phone, and imported history.
--
-- All three are additive. Every existing row keeps its current meaning:
-- `author_name` is null on a one-to-one message, `imported` is false on
-- anything the webhook delivered live, and `is_group` is false on every
-- contact that exists today.
-- ============================================================

-- ============================================================
-- Who actually spoke
--
-- In a one-to-one thread the sender is the contact, so the column stays
-- null. In a group the conversation belongs to the group and each
-- message needs its own author, or the thread reads as one voice.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS author_name TEXT;

COMMENT ON COLUMN messages.author_name IS
  'Display name of the participant who sent this message. Null in a one-to-one thread, where the sender is the conversation''s contact.';

-- ============================================================
-- Imported history
--
-- A backfilled message is a record of something that already happened.
-- It must never look like a new arrival: no unread bump, no automation,
-- no AI reply, no outbound webhook. The flag makes that decision
-- inspectable after the fact rather than implied by a timestamp.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS imported BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN messages.imported IS
  'True when the row was backfilled from provider history rather than delivered live. Imported rows never trigger automations, AI replies or outbound webhooks.';

-- ============================================================
-- Group threads
--
-- A group is stored as a contact so it flows through the existing
-- conversation, inbox and message model unchanged. It has no phone
-- number — the same '' convention migration 022 already tolerates for
-- an identifier-only contact — and is told apart by this flag.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN contacts.is_group IS
  'True when this row represents a WhatsApp group rather than a person. Group rows carry the group JID in whatsapp_contact_identities.';

-- Listing "just the groups" or "just the people" is a normal inbox
-- filter, and both sides are large enough to be worth the index.
CREATE INDEX IF NOT EXISTS idx_contacts_account_is_group
  ON contacts(account_id, is_group);

-- ============================================================
-- History import progress
--
-- An import walks every chat and can take a while, so its state lives in
-- a row rather than in memory: the UI polls it, a second request cannot
-- start a duplicate run, and a crash leaves an inspectable record rather
-- than silence.
--
-- No browser policies. Service-role import code owns this table; the
-- dashboard reads progress through an authenticated route.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_history_imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'uazapi')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  chats_seen INTEGER NOT NULL DEFAULT 0,
  messages_imported INTEGER NOT NULL DEFAULT 0,
  -- Stable reason code, never an upstream message.
  error_code TEXT,
  -- How far the walk has got. An import runs in bounded batches so it
  -- cannot outlive a request, and this is the whole cursor it needs to
  -- pick up again after a stop, a timeout or a closed browser tab.
  chat_offset INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- Idempotent on an installation that already created the table above.
ALTER TABLE whatsapp_history_imports
  ADD COLUMN IF NOT EXISTS chat_offset INTEGER NOT NULL DEFAULT 0;

-- At most one import running per account, enforced in the database
-- rather than by a check-then-insert that two clicks could both pass.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_history_imports_running
  ON whatsapp_history_imports(account_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_whatsapp_history_imports_account
  ON whatsapp_history_imports(account_id, started_at DESC);

ALTER TABLE whatsapp_history_imports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE whatsapp_history_imports IS
  'One row per history backfill run. Progress is polled by Settings; the partial unique index keeps a second run from starting while one is in flight.';
