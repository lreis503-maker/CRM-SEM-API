-- ============================================================
-- CRM - BANCO DE DADOS - PARTE 4 DE 5
--
-- Cole ESTE arquivo inteiro no SQL Editor do Supabase e clique
-- em Run. Depois volte e faca o mesmo com a parte 5.
--
-- IMPORTANTE: rode as partes NA ORDEM, da 1 ate a 5.
--
-- Contem: 038_broadcast_resume.sql ate 052_deal_value_required_in_negotiation.sql
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
-- 043_instagram_messaging.sql
-- ------------------------------------------------------------

-- ============================================================
-- 043_instagram_messaging
--
-- Instagram Direct as an independent messaging channel. Fully
-- separate from contacts/conversations/messages (WhatsApp) — no
-- shared rows, no merged contact identity. See
-- docs/superpowers/specs/2026-09-15-instagram-integration-design.md
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  ig_username TEXT,
  page_access_token TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_config_ig_user_id ON instagram_config(ig_user_id);

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram config" ON instagram_config;
DROP POLICY IF EXISTS "Account admins can manage instagram config" ON instagram_config;
CREATE POLICY "Account members can view instagram config" ON instagram_config
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account admins can manage instagram config" ON instagram_config
  FOR ALL USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS instagram_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  igsid TEXT NOT NULL,
  username TEXT,
  name TEXT,
  profile_pic_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, igsid)
);

CREATE INDEX IF NOT EXISTS idx_instagram_contacts_account ON instagram_contacts(account_id);

ALTER TABLE instagram_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram contacts" ON instagram_contacts;
DROP POLICY IF EXISTS "Account agents can manage instagram contacts" ON instagram_contacts;
CREATE POLICY "Account members can view instagram contacts" ON instagram_contacts
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account agents can manage instagram contacts" ON instagram_contacts
  FOR ALL USING (is_account_member(account_id, 'agent')) WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS instagram_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES instagram_contacts(id) ON DELETE CASCADE,
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_instagram_conversations_account ON instagram_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_contact ON instagram_conversations(contact_id);

ALTER TABLE instagram_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram conversations" ON instagram_conversations;
DROP POLICY IF EXISTS "Account agents can manage instagram conversations" ON instagram_conversations;
CREATE POLICY "Account members can view instagram conversations" ON instagram_conversations
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account agents can manage instagram conversations" ON instagram_conversations
  FOR ALL USING (is_account_member(account_id, 'agent')) WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS instagram_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES instagram_conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent')),
  sender_id UUID,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN (
    'text', 'image', 'video', 'audio', 'file', 'share', 'story_mention', 'story_reply', 'unsupported'
  )),
  content_text TEXT,
  media_url TEXT,
  media_type TEXT,
  ig_message_id TEXT,
  reply_to_message_id UUID REFERENCES instagram_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_messages_conversation ON instagram_messages(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_messages_conv_ig_id
  ON instagram_messages(conversation_id, ig_message_id) WHERE ig_message_id IS NOT NULL;

ALTER TABLE instagram_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram messages" ON instagram_messages;
DROP POLICY IF EXISTS "Account agents can manage instagram messages" ON instagram_messages;
CREATE POLICY "Account members can view instagram messages" ON instagram_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id)
    )
  );
CREATE POLICY "Account agents can manage instagram messages" ON instagram_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id, 'agent')
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id, 'agent')
    )
  );

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON instagram_contacts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON instagram_conversations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'instagram_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE instagram_messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'instagram_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE instagram_conversations;
  END IF;
END $$;


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


-- ------------------------------------------------------------
-- 046_history_import_message_cursor.sql
-- ------------------------------------------------------------

-- ============================================================
-- 046_history_import_message_cursor
--
-- Um import agora percorre a conversa inteira, nao apenas as 200
-- mensagens mais recentes. Uma thread com milhares de mensagens nao
-- cabe em uma requisicao, entao o cursor precisa dizer tambem quao
-- fundo dentro da conversa atual o ultimo lote chegou.
--
-- Aditiva. Linhas existentes ficam com 0, que e exatamente o que
-- significavam antes: comecar a conversa atual da mensagem mais nova.
-- ============================================================

ALTER TABLE whatsapp_history_imports
  ADD COLUMN IF NOT EXISTS message_offset INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN whatsapp_history_imports.message_offset IS
  'How far into the chat at chat_offset the last batch got. Zero means start that chat from its newest message. Together with chat_offset this is the whole resume cursor.';

COMMENT ON COLUMN whatsapp_history_imports.chat_offset IS
  'Chats already walked to the end. The chat AT this offset is the one message_offset refers to.';


-- ------------------------------------------------------------
-- 047_ad_account_monitor.sql
-- ------------------------------------------------------------

-- ============================================================
-- 047_ad_account_monitor
--
-- Monitoramento das contas de anúncio dos clientes e aviso no
-- WhatsApp quando o saldo cai abaixo do limite ou quando a cobrança
-- para (cartão recusado, conta sem forma de pagamento, conta
-- desativada por pagamento).
--
-- O token de usuário de sistema do Business Manager é uma credencial
-- da conta do CRM, não do navegador: ele fica em
-- `ad_platform_credential_secrets`, uma tabela com RLS ligada e sem
-- nenhuma policy, exatamente como `whatsapp_config_secrets` na 043.
-- ============================================================

-- ============================================================
-- Credencial da plataforma de anúncios (uma por conta do CRM)
--
-- Esta linha é legível pelo navegador: ela guarda só metadados
-- (rótulo, id do Business Manager, quando foi validada pela última
-- vez). O token nunca passa por aqui.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_platform_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  -- Como o usuário reconhece esta credencial na tela.
  label TEXT,
  -- Business Manager dono do token, quando informado. Serve para
  -- diagnóstico: um token do BM errado não enxerga as contas.
  business_id TEXT,
  -- Resultado da última chamada de validação. `error` aqui é a
  -- mensagem que a tela mostra; nunca carrega o token.
  last_verified_at TIMESTAMPTZ,
  last_verify_error TEXT,
  -- Número interno que recebe a cópia de todo alerta, em E.164
  -- (ex.: +5511999999999). Fica aqui, e não numa variável de
  -- ambiente, porque cada conta do CRM tem a sua equipe.
  internal_notify_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Uma credencial por plataforma por conta. O token de sistema do BM
  -- da agência já enxerga todas as contas de cliente compartilhadas
  -- com ele, então não há motivo para permitir várias.
  UNIQUE (account_id, platform)
);

ALTER TABLE ad_platform_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_platform_credentials_select ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_insert ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_update ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_delete ON ad_platform_credentials;
CREATE POLICY ad_platform_credentials_select ON ad_platform_credentials
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ad_platform_credentials_insert ON ad_platform_credentials
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ad_platform_credentials_update ON ad_platform_credentials
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY ad_platform_credentials_delete ON ad_platform_credentials
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Token da plataforma — somente service role
--
-- Sem policies de propósito: o navegador não tem caminho até esta
-- tabela nem com RLS correta em outro lugar. O formato conferido é o
-- do AES-256-GCM de src/lib/whatsapp/encryption.ts: IV de 12 bytes,
-- ciphertext não vazio e tag de autenticação de 16 bytes.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_platform_credential_secrets (
  credential_id UUID PRIMARY KEY
    REFERENCES ad_platform_credentials(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  CONSTRAINT ad_platform_credential_secrets_access_token_encrypted_check
    CHECK (access_token ~ '^[0-9A-Fa-f]{24}:[0-9A-Fa-f]+:[0-9A-Fa-f]{32}$')
);

ALTER TABLE ad_platform_credential_secrets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ad_platform_credential_secrets IS
  'Token de usuário de sistema da plataforma de anúncios. Só o service role alcança.';
COMMENT ON COLUMN ad_platform_credential_secrets.access_token IS
  'Ciphertext AES-256-GCM do helper de criptografia do servidor; nunca texto claro.';

-- ============================================================
-- Contas de anúncio monitoradas
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_monitors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  -- Só os dígitos, sem o prefixo `act_`. A API recebe o prefixo; o
  -- banco guarda a forma canônica para a UNIQUE abaixo funcionar
  -- mesmo se a pessoa colar "act_123" numa vez e "123" na outra.
  external_account_id TEXT NOT NULL
    CHECK (external_account_id ~ '^[0-9]{1,32}$'),
  -- Nome que a Meta devolve, atualizado a cada leitura. Cai para o id
  -- quando a conta ainda não foi lida uma vez.
  display_name TEXT,
  -- Contato do CRM que recebe o aviso. ON DELETE SET NULL porque
  -- apagar o contato não deve apagar o histórico de alertas nem parar
  -- o monitoramento: a cópia interna continua saindo.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Limite de saldo baixo, na menor unidade da moeda da conta de
  -- anúncio (centavos). R$ 100,00 = 10000.
  low_balance_threshold_cents BIGINT NOT NULL DEFAULT 10000
    CHECK (low_balance_threshold_cents >= 0),
  -- Moeda lida da Meta, guardada para formatar a mensagem sem uma
  -- segunda chamada. Preenchida na primeira leitura.
  currency TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notify_client BOOLEAN NOT NULL DEFAULT TRUE,
  notify_internal BOOLEAN NOT NULL DEFAULT TRUE,
  -- Enquanto o problema continua, o aviso se repete no máximo uma vez
  -- por esse intervalo. Zero significa avisar só na transição.
  cooldown_hours INTEGER NOT NULL DEFAULT 24
    CHECK (cooldown_hours >= 0 AND cooldown_hours <= 720),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, platform, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_account
  ON ad_account_monitors(account_id)
  WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_contact
  ON ad_account_monitors(account_id, contact_id);

ALTER TABLE ad_account_monitors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_monitors_select ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_insert ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_update ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_delete ON ad_account_monitors;
CREATE POLICY ad_account_monitors_select ON ad_account_monitors
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ad_account_monitors_insert ON ad_account_monitors
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ad_account_monitors_update ON ad_account_monitors
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY ad_account_monitors_delete ON ad_account_monitors
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Última leitura e estado do alerta
--
-- Uma linha por monitor. É aqui que mora a decisão de não repetir o
-- mesmo aviso: `*_active` guarda se o problema já estava valendo na
-- leitura anterior e `*_alert_at` quando o último aviso saiu.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_monitor_state (
  monitor_id UUID PRIMARY KEY
    REFERENCES ad_account_monitors(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ,

  -- Campos crus da Meta, em centavos, exatamente como vieram. Guardados
  -- para o usuário conferir contra o Gerenciador de Anúncios sem
  -- precisar de outra chamada: a Meta não expõe um único campo
  -- "saldo restante" e o cálculo muda entre conta pré-paga e pós-paga.
  balance_cents BIGINT,
  amount_spent_cents BIGINT,
  spend_cap_cents BIGINT,
  -- O saldo que a regra de alerta realmente comparou, ou NULL quando a
  -- conta é pós-paga sem limite de gastos e não existe saldo a comparar.
  available_cents BIGINT,
  currency TEXT,
  is_prepay_account BOOLEAN,
  account_status INTEGER,
  disable_reason INTEGER,
  has_funding_source BOOLEAN,

  low_balance_active BOOLEAN NOT NULL DEFAULT FALSE,
  low_balance_alert_at TIMESTAMPTZ,
  payment_issue_active BOOLEAN NOT NULL DEFAULT FALSE,
  payment_issue_alert_at TIMESTAMPTZ,
  -- Código estável do problema de cobrança (ex.: 'unsettled',
  -- 'no_funding_source'). Trocar de código conta como problema novo.
  payment_issue_code TEXT,

  -- Leituras que falharam em sequência. Serve para não gritar a cada
  -- 15 minutos quando a Meta está fora do ar.
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ad_account_monitor_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_monitor_state_select ON ad_account_monitor_state;
CREATE POLICY ad_account_monitor_state_select ON ad_account_monitor_state
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita: só o runner, com service role, escreve aqui.

-- ============================================================
-- Histórico de avisos enviados
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  monitor_id UUID REFERENCES ad_account_monitors(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'low_balance',
    'payment_stopped',
    'balance_recovered',
    'payment_recovered',
    -- A leitura na Meta falhou de um jeito que precisa de ação
    -- humana (token expirado, acesso removido). Só cópia interna:
    -- não é problema do cliente.
    'read_failed'
  )),
  -- Motivo legível estável, ex.: 'unsettled', 'no_funding_source',
  -- 'disabled', 'below_threshold'.
  reason_code TEXT,
  -- O texto que saiu no WhatsApp, guardado como foi enviado.
  message TEXT NOT NULL,
  -- Números da leitura que gerou o aviso, para auditoria.
  snapshot JSONB,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- 'sent', 'partial' (uma das duas pontas falhou), 'failed', 'skipped'.
  delivery_status TEXT NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('sent', 'partial', 'failed', 'skipped')),
  client_error TEXT,
  internal_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_account_alerts_account_created
  ON ad_account_alerts(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_account_alerts_monitor_created
  ON ad_account_alerts(monitor_id, created_at DESC);

ALTER TABLE ad_account_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_alerts_select ON ad_account_alerts;
CREATE POLICY ad_account_alerts_select ON ad_account_alerts
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita: o histórico é escrito só pelo runner.


-- ------------------------------------------------------------
-- 048_ad_platform_multi_portfolio.sql
-- ------------------------------------------------------------

-- ============================================================
-- 048_ad_platform_multi_portfolio
--
-- A 047 assumiu um portfólio empresarial por conta do CRM: uma
-- credencial, um token, e todo monitor lia por ela. Uma agência com
-- dois portfólios precisa de dois tokens, porque o usuário de sistema
-- de um portfólio não enxerga as contas de anúncio do outro.
--
-- Esta migração:
--   1. permite várias credenciais por conta do CRM, cada uma com um
--      rótulo que identifica o portfólio;
--   2. liga cada conta de anúncio monitorada à credencial do portfólio
--      a que ela pertence.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- 1. Uma credencial por portfólio, não por conta do CRM
-- ============================================================

-- O rótulo deixa de ser enfeite e passa a ser como a pessoa distingue
-- um portfólio do outro na tela. Linhas antigas ganham um nome antes
-- de a coluna virar obrigatória.
UPDATE ad_platform_credentials
   SET label = 'Portfólio principal'
 WHERE label IS NULL OR btrim(label) = '';

ALTER TABLE ad_platform_credentials
  ALTER COLUMN label SET NOT NULL;

-- A unicidade antiga (account_id, platform) é justamente o que
-- impedia o segundo portfólio.
ALTER TABLE ad_platform_credentials
  DROP CONSTRAINT IF EXISTS ad_platform_credentials_account_id_platform_key;

-- Dois portfólios com o mesmo nome na mesma conta do CRM só criariam
-- confusão na hora de escolher qual usar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_platform_credentials_account_label
  ON ad_platform_credentials(account_id, platform, lower(btrim(label)));

COMMENT ON COLUMN ad_platform_credentials.label IS
  'Nome do portfólio empresarial, como a equipe o reconhece. Único por conta.';

-- ============================================================
-- 2. Cada conta de anúncio sabe de qual portfólio ela vem
-- ============================================================
ALTER TABLE ad_account_monitors
  ADD COLUMN IF NOT EXISTS credential_id UUID
    REFERENCES ad_platform_credentials(id) ON DELETE RESTRICT;

COMMENT ON COLUMN ad_account_monitors.credential_id IS
  'Portfólio cujo token lê esta conta. RESTRICT: remover um portfólio com contas ligadas é recusado, em vez de apagá-las em silêncio.';

-- Backfill: quem já existia pertence ao único portfólio que a conta
-- tinha. O filtro de contagem evita atribuir errado numa conta que,
-- por algum motivo, já tivesse mais de uma credencial.
UPDATE ad_account_monitors AS m
   SET credential_id = c.id
  FROM ad_platform_credentials AS c
 WHERE m.credential_id IS NULL
   AND c.account_id = m.account_id
   AND c.platform = m.platform
   AND (
     SELECT count(*) FROM ad_platform_credentials AS c2
      WHERE c2.account_id = m.account_id AND c2.platform = m.platform
   ) = 1;

-- NOT NULL só quando o backfill cobriu tudo. Uma conta do CRM que
-- tenha monitores mas nenhuma credencial (credencial apagada à mão,
-- por exemplo) não deve derrubar a migração: o runner já trata
-- credential_id nulo pulando o monitor e gravando o motivo.
DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM ad_account_monitors WHERE credential_id IS NULL;

  IF v_orphans = 0 THEN
    BEGIN
      ALTER TABLE ad_account_monitors
        ALTER COLUMN credential_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'credential_id continua opcional: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE
      '% monitor(es) sem portfólio. Abra /ads-monitor e escolha o portfólio de cada conta.',
      v_orphans;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_credential
  ON ad_account_monitors(credential_id)
  WHERE enabled;


-- ------------------------------------------------------------
-- 049_ad_account_funding_display.sql
-- ------------------------------------------------------------

-- ============================================================
-- 049_ad_account_funding_display
--
-- Correção da leitura de saldo.
--
-- A 047 tratava o campo `balance` da Meta como saldo restante. Ele é a
-- FATURA EM ABERTO: cresce conforme a conta gasta, em vez de diminuir.
-- Na prática o alerta estava invertido — disparava quando o cliente
-- tinha gasto pouco e silenciava conforme ele gastava.
--
-- O saldo de verdade vem de `funding_source_details.display_string`,
-- o mesmo texto que o Gerenciador de Anúncios mostra
-- ("Saldo disponível (R$278,60 BRL)"). Esta migração guarda esse texto
-- para diagnóstico e corrige os comentários das colunas.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

ALTER TABLE ad_account_monitor_state
  ADD COLUMN IF NOT EXISTS funding_source_display TEXT;

COMMENT ON COLUMN ad_account_monitor_state.funding_source_display IS
  'Texto cru da forma de pagamento na Meta. Guardado para conferir de onde saiu available_cents quando o número parecer errado.';

COMMENT ON COLUMN ad_account_monitor_state.balance_cents IS
  'Campo `balance` da Meta: FATURA EM ABERTO, não saldo. Cresce conforme a conta gasta. O saldo comparado com o limite é available_cents.';

COMMENT ON COLUMN ad_account_monitor_state.available_cents IS
  'O saldo que a regra comparou com o limite. Vem de funding_source_details.display_string quando a Meta informa, ou de spend_cap - amount_spent como rede. NULL quando não há saldo a comparar.';

-- As leituras antigas foram feitas com a regra invertida, então os
-- números gravados descrevem a fatura, não o saldo. Zerar o estado do
-- alerta faz a próxima verificação tratar cada conta como nova: se
-- houver saldo baixo de verdade, o aviso sai; se não, nada sai. Sem
-- isso, uma conta marcada como "em alerta" pela regra velha mandaria
-- um "saldo normalizado" que nunca foi verdade.
UPDATE ad_account_monitor_state
   SET low_balance_active = FALSE,
       low_balance_alert_at = NULL,
       available_cents = NULL,
       checked_at = NULL
 WHERE low_balance_active OR available_cents IS NOT NULL;


-- ------------------------------------------------------------
-- 050_ad_monitor_scheduler.sql
-- ------------------------------------------------------------

-- ============================================================
-- 050_ad_monitor_scheduler
--
-- Duas mudanças pedidas depois da primeira semana de uso:
--
--   1. o próprio CRM passa a verificar as contas de hora em hora, sem
--      depender de um agendador externo;
--   2. o aviso de saldo baixo sai UMA VEZ por evento, e não a cada
--      ciclo — verificar de hora em hora não pode virar uma mensagem
--      por hora no WhatsApp do cliente.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- 1. Trava do agendador
--
-- O agendador roda dentro do processo do CRM. Se o Railway subir duas
-- instâncias, as duas acordam na mesma hora e verificariam as mesmas
-- contas — e o cliente receberia a mensagem duas vezes.
--
-- Uma linha só, com prazo de validade. Quem consegue o UPDATE
-- condicional roda o ciclo; quem não consegue volta a dormir. O UPDATE
-- é atômico no Postgres, então não existe empate.
--
-- Prazo em vez de "liberar no fim": se a instância que pegou a trava
-- morrer no meio do ciclo, a trava se solta sozinha em vez de travar o
-- monitoramento para sempre.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_monitor_scheduler_lease (
  -- Chave booleana com CHECK: garante fisicamente uma linha só.
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  locked_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  /** Identifica a instância que segurou a trava por último. Diagnóstico. */
  holder TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ad_monitor_scheduler_lease (id, locked_until)
VALUES (TRUE, NOW())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE ad_monitor_scheduler_lease ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ad_monitor_scheduler_lease IS
  'Trava de instância única do agendador do monitor de anúncios. Sem policies: só o service role alcança.';

-- ============================================================
-- 2. Um aviso por evento
--
-- `cooldown_hours = 0` significa "avise só na transição": o aviso sai
-- quando o saldo cruza para baixo do limite e não se repete enquanto
-- continuar lá. Um novo aviso só acontece depois de o saldo se
-- recuperar (e cruzar para baixo de novo).
-- ============================================================
ALTER TABLE ad_account_monitors
  ALTER COLUMN cooldown_hours SET DEFAULT 0;

UPDATE ad_account_monitors
   SET cooldown_hours = 0
 WHERE cooldown_hours <> 0;

COMMENT ON COLUMN ad_account_monitors.cooldown_hours IS
  'Intervalo mínimo entre avisos repetidos do mesmo problema. Zero (padrão) avisa só na transição — uma mensagem por evento.';


-- ------------------------------------------------------------
-- 051_message_ad_referral.sql
-- ------------------------------------------------------------

-- ============================================================
-- 051_message_ad_referral
--
-- Guarda o anúncio que o lead clicou antes de escrever (anúncios de
-- "Enviar mensagem" no Facebook e no Instagram). O WhatsApp mostra
-- esse anúncio como um cartão com foto, título e texto em cima da
-- primeira mensagem; a caixa de entrada do CRM passa a mostrar o mesmo.
--
-- Uma coluna JSONB só, preenchida apenas nas mensagens que vieram de
-- anúncio. As demais continuam NULL. Formato:
--
--   {
--     "source":        "meta_referral" | "uazapi_external_ad_reply" | "uazapi_signal",
--     "source_type":   "ad" | "post",
--     "source_id":     "<id do anúncio>",
--     "source_url":    "https://fb.me/...",
--     "title":         "<título do anúncio>",
--     "body":          "<texto do anúncio>",
--     "media_type":    "image" | "video",
--     "thumbnail_url": "<cópia no chat-media, ou o link do provedor>",
--     "media_url":     "<link do provedor>",
--     "ctwa_clid":     "<id do clique>",
--     "raw":           { ...cópia higienizada do que o provedor mandou }
--   }
--
-- Segura de rodar mais de uma vez. Pode rodar antes ou depois do
-- deploy: o código novo só escreve a coluna quando há anúncio, e se a
-- coluna ainda não existir ele guarda a mensagem sem o cartão.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ad_referral JSONB;

COMMENT ON COLUMN messages.ad_referral IS
  'Anúncio de clique para o WhatsApp que originou a mensagem (título, texto, foto, link). NULL quando a mensagem não veio de anúncio. Migração 051.';

-- Para relatórios de "quais anúncios trazem leads": só as linhas que
-- têm anúncio entram no índice.
CREATE INDEX IF NOT EXISTS idx_messages_ad_referral_source_id
  ON messages ((ad_referral->>'source_id'))
  WHERE ad_referral IS NOT NULL;


-- ------------------------------------------------------------
-- 052_deal_value_required_in_negotiation.sql
-- ------------------------------------------------------------

-- ============================================================
-- 052_deal_value_required_in_negotiation
--
-- Um negócio só pode entrar (ou ficar) na etapa de negociação com
-- valor maior que zero. O vendedor precisa informar o preço.
--
-- A regra vale pelo NOME da etapa: qualquer etapa cujo nome contenha
-- "negocia" (Negociação, Em negociação, Negociacao...). Assim ela vale
-- para todos os funis, inclusive os criados depois, sem configuração.
--
-- A tela já pede o valor antes de mover o card; esta trava no banco
-- garante o mesmo para a API pública e para as automações.
--
-- Negócios que JÁ estão em negociação sem valor não são alterados nem
-- bloqueados: a trava só age quando o negócio entra na etapa ou quando
-- alguém tenta zerar o valor dele lá dentro.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

CREATE OR REPLACE FUNCTION stage_requires_deal_value(p_stage_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pipeline_stages
     WHERE id = p_stage_id
       AND name ILIKE '%negocia%'
  );
$$;

CREATE OR REPLACE FUNCTION enforce_deal_value_in_negotiation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.value, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- Só quando o negócio entra na etapa ou o valor muda. Editar outro
  -- campo de um negócio antigo sem valor continua permitido.
  IF TG_OP = 'UPDATE'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
     AND NEW.value IS NOT DISTINCT FROM OLD.value THEN
    RETURN NEW;
  END IF;

  IF stage_requires_deal_value(NEW.stage_id) THEN
    RAISE EXCEPTION 'deal_value_required'
      USING ERRCODE = 'check_violation',
            HINT = 'Informe o valor do negócio antes de colocá-lo em negociação.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_value_in_negotiation ON deals;
CREATE TRIGGER trg_deal_value_in_negotiation
  BEFORE INSERT OR UPDATE OF stage_id, value ON deals
  FOR EACH ROW
  EXECUTE FUNCTION enforce_deal_value_in_negotiation();
