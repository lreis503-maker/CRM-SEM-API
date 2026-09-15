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
