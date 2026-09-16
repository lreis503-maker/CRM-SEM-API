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
