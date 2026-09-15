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
