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
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
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
      AND uazapi_instance_token IS NULL
      AND uazapi_webhook_secret_hash IS NULL
      AND connection_attempt_id IS NULL)
    OR
    (provider = 'uazapi'
      AND phone_number_id IS NULL
      AND waba_id IS NULL
      AND access_token IS NULL
      AND verify_token IS NULL
      AND uazapi_instance_id IS NOT NULL
      AND uazapi_instance_token IS NOT NULL
      AND uazapi_webhook_secret_hash IS NOT NULL
      AND connection_attempt_id IS NOT NULL)
  );

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
