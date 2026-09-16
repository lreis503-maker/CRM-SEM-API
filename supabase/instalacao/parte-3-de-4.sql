-- ============================================================
-- CRM - BANCO DE DADOS - PARTE 3 DE 4
--
-- Cole ESTE arquivo inteiro no SQL Editor do Supabase e clique
-- em Run. Depois volte e faca o mesmo com a parte 4.
--
-- IMPORTANTE: rode as partes NA ORDEM, da 1 ate a 4.
--
-- Contem: 023_chat_media.sql ate 037_webhook_broadcast_reliability.sql
--
-- E seguro rodar de novo se voce se perder: tudo aqui usa
-- IF NOT EXISTS ou DROP ... IF EXISTS, entao repetir uma parte
-- nao apaga dados nem quebra nada.
-- ============================================================

-- ------------------------------------------------------------
-- 023_chat_media.sql
-- ------------------------------------------------------------

-- ============================================================
-- 023_chat_media.sql
--
-- Adds the `chat-media` Supabase Storage bucket used when an agent
-- sends a photo / video / document / voice note from the inbox
-- composer (issue #213). Today media can only be RECEIVED from
-- customers or sent via the Flows `send_media` node — never typed
-- and sent live in a 1:1 thread.
--
-- Mirrors the `flow-media` bucket (migration 016) and its
-- account-scoped storage RLS (migration 020), with two differences:
--
--   1. A separate bucket so chat attachments and flow-builder media
--      stay conceptually distinct (and so a future per-bucket size /
--      retention policy can diverge without touching flows).
--
--   2. The allowed MIME list adds the audio types Meta accepts for
--      outbound voice notes — audio/ogg (Opus), audio/mpeg, audio/aac,
--      audio/mp4, audio/amr. Browser recordings (WebM/Opus) are
--      transcoded to audio/ogg BEFORE upload, so WebM never lands
--      here and isn't allow-listed.
--
-- Path convention (same as flow-media post-020):
--   chat-media/account-<account_id>/<timestamp>-<basename>.<ext>
-- The bucket is public so Meta can fetch the URL without auth; writes
-- are scoped to account members via the path's first segment.
--
-- Size limit 16 MB — Meta's tightest universal cap (video). Documents
-- can technically be 100 MB on Meta, but we hold the universal cap to
-- match flow-media and keep one limit to reason about.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. chat-media storage bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  TRUE,
  16777216, -- 16 MB (Meta video cap; documents/images/audio fit under this)
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp',
    -- Videos
    'video/mp4', 'video/3gpp',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    -- Audio (voice notes) — only Meta-accepted outbound types. Browser
    -- WebM/Opus is transcoded to audio/ogg before upload.
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. Storage RLS — account-scoped writes, public reads
--
-- Same predicate shape as migration 020's flow-media policies:
-- writes are allowed when the path's first segment is
-- `account-<account_id>` for an account the caller belongs to.
-- Reads are public (the bucket is public so Meta can fetch links).
--
-- Drop-then-create (Postgres has no CREATE POLICY IF NOT EXISTS).
-- ============================================================
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
CREATE POLICY "Chat media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chat-media');

DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );


-- ------------------------------------------------------------
-- 024_member_presence.sql
-- ------------------------------------------------------------

-- ============================================================
-- 024_member_presence.sql — team member presence (online / away)
--
-- Adds a lightweight presence layer so the Team members roster (and
-- the inbox Assign dropdown) can show who is actively using the
-- dashboard, idle, or gone. Implements wacrm#269.
--
-- Design
--
--   The active client heartbeats its own row through the
--   `touch_presence` RPC roughly every 30s, storing only 'online'
--   or 'away'. "Offline" is NOT stored — viewers derive it from
--   staleness (`now() - last_seen_at` beyond a threshold), so a
--   closed tab / logout resolves to offline automatically without
--   relying on an unreliable unload write.
--
--   A dedicated table keeps the high-write heartbeat off the
--   otherwise-stable `profiles` row and scopes Realtime cleanly.
--
-- Visibility
--
--   Any account member can read presence for their account — the
--   same visibility as the read-only roster (`is_account_member`).
--   Writes go ONLY through the SECURITY DEFINER RPC, which derives
--   the account from the caller's profile (never client-supplied).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- table -------------------------------------------------
CREATE TABLE IF NOT EXISTS member_presence (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_presence_account_idx
  ON member_presence(account_id);

-- ---- RLS ---------------------------------------------------
ALTER TABLE member_presence ENABLE ROW LEVEL SECURITY;

-- Account members may read every presence row for their account.
-- No client INSERT/UPDATE/DELETE policy exists: all writes flow
-- through touch_presence() below.
DROP POLICY IF EXISTS member_presence_select ON member_presence;
CREATE POLICY member_presence_select ON member_presence FOR SELECT
  USING (is_account_member(account_id));

-- ---- heartbeat RPC -----------------------------------------
-- Upserts the caller's presence row. SECURITY DEFINER so it can
-- write despite the absence of a client write policy; the account
-- is resolved from the caller's own profile, so a client can never
-- spoof which account it appears in.
CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (auth.uid(), v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;
END;
$$;

-- ---- realtime ----------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'member_presence'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE member_presence;
  END IF;
END $$;


-- ------------------------------------------------------------
-- 025_filter_contacts_by_tags.sql
-- ------------------------------------------------------------

-- ============================================================
-- 025_filter_contacts_by_tags.sql — server-side tag filter
--
-- Why an RPC
--
--   The Contacts page filters by tag by resolving the selected
--   tags to contact ids and paging the result. Doing that on the
--   client (SELECT contact_id FROM contact_tags WHERE tag_id IN …,
--   then .in('id', ids) on contacts) hits two PostgREST limits for
--   accounts where a tag covers many contacts:
--     - the unbounded contact_tags select is silently capped
--       (~1000 rows), dropping contacts from the filter, and
--     - the follow-up .in('id', ids) pushes every matching id into
--       one IN-clause (the ~1000-value cap the broadcast sender
--       already pages around) and bloats the request URL.
--
--   Both break the total count and pagination. This function does
--   the join, de-duplication (OR across tags), ordering, windowed
--   total count, and LIMIT/OFFSET in one query so the result is
--   always complete and correctly counted.
--
-- Security
--
--   SECURITY INVOKER (the default): the function runs as the
--   caller, so the existing RLS on `contacts` and `contact_tags`
--   (account membership, migration 017) scopes the result to the
--   caller's account. No privilege bypass — unlike the SECURITY
--   DEFINER member RPCs in 018/019.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email search as the list.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) TO authenticated;


-- ------------------------------------------------------------
-- 026_api_keys.sql
-- ------------------------------------------------------------

-- ============================================================
-- 026_api_keys.sql — Public API credentials (groundwork)
--
-- Adds the `api_keys` table backing the public REST API
-- (`/api/v1/*`). A key authenticates a *machine* caller (a script,
-- an n8n/Zapier-style automation, a cron) against one account, the
-- same way the cookie session authenticates a *human* in the
-- dashboard.
--
-- Design notes
--   - Account-scoped, never user-scoped. A key belongs to the
--     account; `created_by` only records who minted it (audit), and
--     is ON DELETE SET NULL so removing a teammate doesn't cascade-
--     delete the keys their automations still depend on.
--   - We store only the SHA-256 *hash* of the key, never plaintext.
--     A leaked DB snapshot (backup, log, support export) therefore
--     can't be replayed against the API — the caller would need the
--     original key, which is returned exactly once at creation. Same
--     pattern as `account_invitations.token_hash` (migration 017/019).
--   - `key_prefix` is a short, non-secret display string
--     (`wacrm_live_a1b2c3d4`) so the dashboard can show "which key
--     is this" in a list without ever resurfacing the secret.
--   - Authorization is by `scopes[]` (scopes-only model), resolved
--     in the application layer (`src/lib/api-keys/scopes.ts`). The
--     DB doesn't constrain the scope vocabulary — a future scope is
--     a code change, not a migration.
--
-- RLS
--   `api_keys` is a settings-class table: any member may *read* the
--   roster of keys for their account; only admin+ may create/revoke
--   (mirrors the `tags` / `custom_fields` policies in 017). The
--   public-API auth path itself reads keys with the service-role
--   client (RLS-bypassing) because an API caller has no Supabase
--   session and therefore no `auth.uid()` for a policy to match.
--
-- Idempotent — safe to run multiple times. Table uses IF NOT
-- EXISTS; policies are dropped before recreate (Postgres has no
-- CREATE POLICY IF NOT EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name         text NOT NULL,
  key_prefix   text NOT NULL,             -- display only, e.g. "wacrm_live_a1b2c3d4"
  key_hash     text NOT NULL UNIQUE,      -- SHA-256 hex of the full plaintext key
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,               -- NULL = never expires
  revoked_at   timestamptz,               -- NULL = active
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- account_id: every "list this account's keys" query filters on it.
CREATE INDEX IF NOT EXISTS api_keys_account_id_idx ON api_keys (account_id);
-- key_hash: the hot path is the per-request auth lookup by hash. The
-- UNIQUE constraint already creates an index, but spell it out so the
-- intent (this is the lookup key) is documented and survives a future
-- drop of the UNIQUE constraint.
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the roster.
-- key_hash is in the table but the dashboard never selects it.
DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class). Revoking a
-- key is an UPDATE that sets `revoked_at`; we keep DELETE available
-- too for operators who'd rather hard-delete.
DROP POLICY IF EXISTS api_keys_insert ON api_keys;
CREATE POLICY api_keys_insert ON api_keys FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS api_keys_update ON api_keys;
CREATE POLICY api_keys_update ON api_keys FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS api_keys_delete ON api_keys;
CREATE POLICY api_keys_delete ON api_keys FOR DELETE
  USING (is_account_member(account_id, 'admin'));


-- ------------------------------------------------------------
-- 027_notifications.sql
-- ------------------------------------------------------------

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Recipient — the agent this notification is for.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'conversation_assigned'
    CHECK (type IN ('conversation_assigned')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Who triggered the notification. NULL means an automation / the
  -- system did it rather than a signed-in teammate.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id)
  WHERE read_at IS NULL;

-- Full replica identity so realtime UPDATE payloads include old column
-- values. Without this, payload.old only carries the primary key, which
-- makes it impossible to derive whether a row was unread before the update.
ALTER TABLE notifications REPLICA IDENTITY FULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Recipients can read and mark their own notifications as read.
-- No client INSERT/DELETE policy — rows are created exclusively by
-- the SECURITY DEFINER trigger function below.
DROP POLICY IF EXISTS notifications_select ON notifications;
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (auth.uid() = user_id);
-- Only read_at updates are meaningful from the client; restrict via a
-- column-level security policy so other fields cannot be rewritten.
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Restrict to read_at column only at the column-privilege level so
-- clients cannot overwrite title, body, or other immutable fields.
REVOKE UPDATE ON notifications FROM authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;

-- ============================================================
-- TRIGGER — notify on conversation assignment
-- ============================================================
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_assigned ON conversations;
CREATE TRIGGER on_conversation_assigned
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_conversation_assigned();

-- ============================================================
-- ENABLE REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;


-- ------------------------------------------------------------
-- 028_webhook_endpoints.sql
-- ------------------------------------------------------------

-- ============================================================
-- 028_webhook_endpoints.sql — Outbound event webhooks (public API)
--
-- Lets an account register HTTPS endpoints that wacrm POSTs to when
-- something happens (an inbound message arrives, a delivery status
-- changes, a conversation is created). This is the "react to inbound"
-- half of the public API (#245): instead of polling
-- `GET /api/v1/conversations`, an automation subscribes once and is
-- pushed the events it cares about.
--
-- Design notes
--   - Account-scoped, never user-scoped (same as `api_keys`).
--     `created_by` records who registered it (audit); ON DELETE SET
--     NULL so removing a teammate doesn't drop their integration's
--     endpoint.
--   - `secret` is the HMAC signing key. UNLIKE `api_keys` (where we
--     store only a hash because the key is a bearer credential the
--     *client* presents), here *we* sign each outgoing payload with
--     the secret and the receiver verifies it — so we need the
--     plaintext at delivery time. We store it AES-256-GCM-encrypted
--     at rest (same `encrypt()`/`decrypt()` as `whatsapp_config.
--     access_token`), and return the plaintext to the creator exactly
--     once so they can configure their verifier.
--   - `events[]` is the subscription filter (free text[], validated
--     in the app layer against `src/lib/webhooks/events.ts` — a new
--     event type is a code change, not a migration, mirroring scopes).
--   - `failure_count` counts *consecutive* delivery failures; the
--     deliverer auto-sets `is_active = false` once it crosses a
--     threshold so a permanently-dead endpoint stops being retried.
--     A successful delivery resets it to 0.
--
-- RLS
--   Settings-class, mirroring `api_keys`: any member may read the
--   roster; only admin+ may create/update/delete. The delivery path
--   and the public-API management routes both use the service-role
--   client (an API caller has no `auth.uid()`), so RLS is the guard
--   for any dashboard UI that reads the table directly.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  url              text NOT NULL,             -- HTTPS endpoint we POST to
  secret           text NOT NULL,             -- AES-256-GCM-encrypted HMAC signing secret
  events           text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  last_delivery_at timestamptz,               -- last successful delivery
  failure_count    integer NOT NULL DEFAULT 0, -- consecutive failures; reset to 0 on success
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Every delivery + management query filters by account_id.
CREATE INDEX IF NOT EXISTS webhook_endpoints_account_id_idx
  ON webhook_endpoints (account_id);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the roster.
DROP POLICY IF EXISTS webhook_endpoints_select ON webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS webhook_endpoints_insert ON webhook_endpoints;
CREATE POLICY webhook_endpoints_insert ON webhook_endpoints FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS webhook_endpoints_update ON webhook_endpoints;
CREATE POLICY webhook_endpoints_update ON webhook_endpoints FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS webhook_endpoints_delete ON webhook_endpoints;
CREATE POLICY webhook_endpoints_delete ON webhook_endpoints FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Atomic consecutive-failure counter.
--
-- The deliverer records failures through this function rather than a
-- read-modify-write: two deliveries to the same endpoint can run
-- concurrently (e.g. conversation.created + message.received for one
-- inbound message), and a client-side `count = count + 1` would lose
-- increments, so a dead endpoint might never reach the auto-disable
-- threshold. The `+ 1` and the disable decision happen in one UPDATE.
-- Only ever disables (never re-enables) — re-enabling is an explicit
-- PATCH by an admin, which resets the counter.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_webhook_failure(
  endpoint_id uuid,
  max_failures int
)
RETURNS void AS $$
  UPDATE webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE
        WHEN failure_count + 1 >= max_failures THEN false
        ELSE is_active
      END
  WHERE id = endpoint_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;


-- ------------------------------------------------------------
-- 029_ai_reply.sql
-- ------------------------------------------------------------

-- ============================================================
-- 029_ai_reply.sql — AI reply assistant (bring-your-own-key)
--
-- Adds the account-level config for the AI reply assistant plus the
-- two per-conversation columns the auto-reply bot needs to stay
-- bounded.
--
-- Design notes
--   - `ai_configs` is account-scoped and UNIQUE(account_id) — one AI
--     setup per workspace, exactly like `whatsapp_config`. Teammates
--     inside an account share it.
--   - `api_key` is the caller's own OpenAI / Anthropic key. We call
--     the provider *with* it on every draft/auto-reply, so we need the
--     plaintext at call time — stored AES-256-GCM-encrypted at rest
--     (same `encrypt()`/`decrypt()` as `whatsapp_config.access_token`
--     and `webhook_endpoints.secret`) and never returned to the client
--     after save (the settings UI shows a masked placeholder).
--   - `created_by` records who saved it (audit); ON DELETE SET NULL so
--     removing a teammate doesn't drop the workspace's AI config.
--   - `is_active` is the master switch (draft + auto-reply both off
--     when false). `auto_reply_enabled` gates only the inbound bot;
--     `auto_reply_max_per_conversation` caps how many times the bot
--     will answer one thread before going quiet (prevents runaway
--     loops / bill blowout on a chatty customer).
--
--   - `conversations.ai_autoreply_disabled` — set true when the model
--     signals a human handoff, or when someone turns the bot off for
--     that one thread. Sticky: once a conversation is handed off it
--     stays off until explicitly re-enabled.
--   - `conversations.ai_reply_count` — running count of bot auto-
--     replies in the thread, checked against
--     `auto_reply_max_per_conversation`.
--
-- RLS
--   Settings-class, mirroring `whatsapp_config` / `webhook_endpoints`:
--   any member (viewer+) may read the config — the inbox draft button
--   needs to know whether AI is on — but only admin+ may create /
--   update / delete it. The auto-reply path runs under the service-role
--   client (a webhook has no `auth.uid()`), so RLS guards dashboard
--   reads, not the engine.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_configs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                        uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider                          text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model                             text NOT NULL,
  api_key                           text NOT NULL,            -- AES-256-GCM-encrypted BYO provider key
  system_prompt                     text,                     -- business context / persona / tone
  is_active                         boolean NOT NULL DEFAULT false,
  auto_reply_enabled                boolean NOT NULL DEFAULT false,
  auto_reply_max_per_conversation   integer NOT NULL DEFAULT 3
                                      CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 20),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_configs ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the config so
-- the inbox knows whether the "Draft with AI" affordance is live.
DROP POLICY IF EXISTS ai_configs_select ON ai_configs;
CREATE POLICY ai_configs_select ON ai_configs FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS ai_configs_insert ON ai_configs;
CREATE POLICY ai_configs_insert ON ai_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_configs_update ON ai_configs;
CREATE POLICY ai_configs_update ON ai_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_configs_delete ON ai_configs;
CREATE POLICY ai_configs_delete ON ai_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh on every write.
CREATE OR REPLACE FUNCTION public.update_ai_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_configs_updated_at ON ai_configs;
CREATE TRIGGER ai_configs_updated_at
  BEFORE UPDATE ON ai_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_configs_updated_at();

-- ============================================================
-- Per-conversation auto-reply control.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_autoreply_disabled boolean NOT NULL DEFAULT false;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_reply_count integer NOT NULL DEFAULT 0;

-- ============================================================
-- Atomic auto-reply slot claim.
--
-- The bot claims a reply slot through this function rather than a
-- read-then-write from the app: two inbound messages on one
-- conversation can be processed concurrently, and a client-side
-- "read count, check < cap, then increment" would let both pass the
-- check and overshoot the per-conversation cap. Here the cap check and
-- the `+ 1` happen in a single UPDATE, so exactly `max_replies` slots
-- can ever be claimed. Returns true when a slot was claimed (the caller
-- may send), false when the cap is already reached (skip).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_reply_count < max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- The auto-reply bot claims slots under the service-role client (the
-- inbound webhook has no auth.uid()), so it needs EXECUTE. SECURITY
-- DEFINER alone is not enough — it sets the privileges the function runs
-- *with*, not who may call it. Without this grant the RPC fails with
-- permission-denied on instances where the default PUBLIC execute
-- privilege has been revoked (hardened / self-hosted Supabase), and the
-- bot silently never replies. Only the service role claims slots, so we
-- grant to it alone (mirrors 007 / 012). See migration 031 / issue #345.
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;


-- ------------------------------------------------------------
-- 030_ai_knowledge.sql
-- ------------------------------------------------------------

-- ============================================================
-- 030_ai_knowledge.sql — AI knowledge base (RAG grounding)
--
-- Gives the AI assistant (migration 029) an account-owned knowledge
-- base — FAQ / policy / product text — that it retrieves into every
-- draft and auto-reply, so it can answer business-specific questions
-- instead of handing off.
--
-- Hybrid retrieval:
--   - Lexical: a generated `fts` tsvector on each chunk, ranked with
--     ts_rank. Works for every account with no extra credentials.
--   - Semantic: an optional pgvector `embedding` per chunk (OpenAI
--     text-embedding-3-small, 1536 dims), populated only when the
--     account configures an embeddings key. Anthropic-only accounts
--     (Anthropic has no embeddings API) keep the lexical path with
--     zero extra setup.
--
-- pgvector: `CREATE EXTENSION IF NOT EXISTS vector` works on a stock
-- Postgres. On hosted Supabase the extension usually lives in the
-- `extensions` schema — if your project pins that, run
-- `create extension if not exists vector with schema extensions;`
-- once, then this file is a no-op for the extension.
--
-- RLS: settings-class, mirroring `ai_configs` / `whatsapp_config` —
-- any member may read the knowledge base; only admin+ may change it.
-- The retrieval RPCs and the ingest path run under the service-role
-- client (the auto-reply bot has no auth.uid()), so RLS guards
-- dashboard reads.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Optional embeddings key (OpenAI-compatible). When set, the KB is
-- embedded and semantic search turns on. Stored AES-256-GCM-encrypted,
-- same as ai_configs.api_key.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_api_key text;

-- ============================================================
-- Documents — one row per KB entry the user pastes (title + body).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title       text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_account_id_idx
  ON ai_knowledge_documents (account_id);

ALTER TABLE ai_knowledge_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_knowledge_documents_select ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_select ON ai_knowledge_documents FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_knowledge_documents_insert ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_insert ON ai_knowledge_documents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_documents_update ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_update ON ai_knowledge_documents FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_documents_delete ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_delete ON ai_knowledge_documents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_knowledge_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_knowledge_documents_updated_at ON ai_knowledge_documents;
CREATE TRIGGER ai_knowledge_documents_updated_at
  BEFORE UPDATE ON ai_knowledge_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_knowledge_documents_updated_at();

-- ============================================================
-- Chunks — retrieval units. `account_id` is denormalized off the
-- document so the match RPCs and RLS filter without a join.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL DEFAULT 0,
  content      text NOT NULL,
  -- Language-neutral FTS config: wacrm is used in many languages
  -- (its markets include BR / LATAM / IN), and this lexical path is the
  -- fallback for accounts without an embeddings key. `'simple'` tokenizes
  -- + lowercases without English-only stemming/stopwords, so it degrades
  -- gracefully in any language. (Per-account language config is a
  -- follow-up; accounts wanting paraphrase/morphology matching add an
  -- embeddings key for the semantic path.)
  fts          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_account_id_idx
  ON ai_knowledge_chunks (account_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_document_id_idx
  ON ai_knowledge_chunks (document_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_fts_idx
  ON ai_knowledge_chunks USING gin (fts);
-- Cosine-distance ANN index for the semantic path. Rows with a NULL
-- embedding (lexical-only accounts) are simply absent from it.
--
-- HNSW (not IVFFlat): per-account knowledge bases start empty and grow
-- incrementally, and IVFFlat must be trained on existing rows — built
-- against an empty/tiny table its centroids are meaningless and recall
-- is poor until it's large and REINDEXed. HNSW needs no training and is
-- accurate from the first row.
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_idx
  ON ai_knowledge_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_knowledge_chunks_select ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_insert ON ai_knowledge_chunks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_chunks_update ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_update ON ai_knowledge_chunks FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_delete ON ai_knowledge_chunks FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Retrieval RPCs. Both SECURITY DEFINER and hard-scoped to the passed
-- account_id so the service-role caller can only ever read one
-- account's chunks.
-- ============================================================

-- Lexical: full-text rank. `plainto_tsquery` turns a raw customer
-- message into a query safely (no operator injection). Uses the same
-- language-neutral `'simple'` config as the stored `fts` column.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Semantic: cosine distance against the query embedding. Only rows
-- that actually have an embedding participate.
--
-- `p_query_embedding` is declared `text` (not `vector`) and cast inside:
-- the caller sends the canonical pgvector literal `[0.1,0.2,...]` as a
-- plain string, so there's no ambiguity in how PostgREST binds a JSON
-- value to a `vector` parameter. Casting a literal to a constant vector
-- still lets the HNSW index serve the `<=>` order-by.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Lock down EXECUTE (mirrors migrations 018 / 025). These are
-- SECURITY DEFINER and would otherwise default to PUBLIC — i.e. the
-- anon role — which, since the function bypasses RLS and only gates on
-- the passed account_id, would let an unauthenticated caller read any
-- account's knowledge base. The draft path calls them as `authenticated`
-- and the auto-reply bot as `service_role`.
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;


-- ------------------------------------------------------------
-- 031_ai_reply_slot_grant.sql
-- ------------------------------------------------------------

-- ============================================================
-- 031_ai_reply_slot_grant.sql — fix: AI auto-reply never fires
--
-- Migration 029 created `claim_ai_reply_slot(uuid, integer)` as a
-- SECURITY DEFINER function but never GRANTed EXECUTE on it — the only
-- function in the schema missing its grant (cf. 007, 012, 018, 019,
-- 025, 030, which all grant EXECUTE explicitly).
--
-- SECURITY DEFINER changes the privileges a function runs *with*, not
-- who may *call* it: the caller still needs EXECUTE. On Postgres
-- instances where the default PUBLIC execute privilege on public-schema
-- functions has been revoked (standard on hardened / self-hosted
-- Supabase), `service_role` therefore cannot invoke it. The AI
-- auto-reply path runs entirely under the service-role client (the
-- inbound webhook has no auth.uid()), so `db.rpc('claim_ai_reply_slot')`
-- fails with permission-denied, the caller bails before sending, and the
-- bot silently never answers ANY inbound message — while the Playground
-- (which never claims a slot) keeps working. See issue #345.
--
-- Only the service role ever claims a slot, so we grant to it alone —
-- matching the increment-counter precedent in 007 / 012, and never
-- exposing a counter-mutating function to end users.
--
-- Idempotent — GRANT is a no-op when the privilege already exists.
-- ============================================================

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;


-- ------------------------------------------------------------
-- 032_fix_ai_knowledge_membership.sql
-- ------------------------------------------------------------

-- ============================================================
-- 032_fix_ai_knowledge_membership.sql — stop cross-account KB
--                                        reads (GHSA-fg5p-2qc3-jmxr, H2)
--
-- The problem
--
--   `match_ai_knowledge_fts` and `match_ai_knowledge_semantic`
--   (migration 030) are SECURITY DEFINER, so they bypass RLS. They
--   filter only on the caller-supplied `p_account_id` and never
--   call `is_account_member()`, yet they are GRANTed to
--   `authenticated`. The 030 header assumed only the service-role
--   bot would call them, but any logged-in user can hit PostgREST
--   directly with a foreign `p_account_id` and read another
--   tenant's knowledge base:
--
--     POST /rest/v1/rpc/match_ai_knowledge_fts
--       { "p_account_id": "<victim>", "p_query": "price",
--         "p_match_count": 1000 }
--
-- The fix
--
--   Recreate both functions as SECURITY INVOKER — the only change
--   is the security mode; the bodies are byte-for-byte the same.
--   The existing SELECT policy
--     ai_knowledge_chunks_select = is_account_member(account_id)
--   then governs `authenticated` callers, so a foreign
--   `p_account_id` returns zero rows, while the auto-reply bot
--   (service_role) still bypasses RLS and works unchanged. This
--   mirrors the deliberate SECURITY INVOKER choice in
--   `filter_contacts_by_tags` (migration 025).
--
--   The legitimate draft path already passes the caller's *own*
--   accountId (see src/lib/ai/knowledge.ts → retrieveKnowledge),
--   so it keeps returning that account's chunks under RLS.
--
-- NOTE FOR MAINTAINER
--
--   This migration was not run against a live database. Validate
--   the two checks at the bottom in your own environment. If you
--   would rather keep these SECURITY DEFINER, the alternative is to
--   add `AND (auth.role() = 'service_role' OR
--   is_account_member(p_account_id))` to each WHERE clause instead.
-- ============================================================

-- Lexical: full-text rank. Body unchanged from migration 030 —
-- only SECURITY DEFINER → SECURITY INVOKER differs.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- Semantic: cosine distance. Body unchanged from migration 030 —
-- only SECURITY DEFINER → SECURITY INVOKER differs.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- Re-assert the EXECUTE grants (CREATE OR REPLACE preserves them,
-- but keep them explicit and re-runnable — mirrors migration 030).
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;

-- ============================================================
-- Manual validation (run against a live instance — no automated
-- SQL test harness exists in this repo):
--
--   1. As a non-member JWT, calling either RPC with a foreign
--      p_account_id must return zero rows:
--        POST /rest/v1/rpc/match_ai_knowledge_fts
--          { "p_account_id": "<other-account>", "p_query": "price",
--            "p_match_count": 1000 }              -> []
--   2. The draft flow (own accountId, authenticated) and the
--      auto-reply bot (service_role) must still return the
--      account's own chunks.
-- ============================================================


-- ------------------------------------------------------------
-- 033_ai_reply_polish.sql
-- ------------------------------------------------------------

-- ============================================================
-- 033_ai_reply_polish.sql — AI reply assistant polish
--
-- Follow-ups to 029_ai_reply / 030_ai_knowledge that make the
-- auto-reply bot visible and controllable from the inbox, complete the
-- handoff, and record token spend:
--
--   1. messages.ai_generated       — marks a reply the bot sent (vs a
--                                     deterministic Flow/bot send), so
--                                     the inbox can badge it "AI".
--   2. ai_configs.handoff_agent_id — where a handed-off conversation is
--                                     routed. NULL = leave unassigned
--                                     (drop into the shared queue).
--   3. conversations.ai_handoff_summary
--                                  — a short internal note the bot writes
--                                    when it hands off, surfaced to the
--                                    agent who takes over.
--   4. ai_usage_log                — per-run provider token usage, for
--                                    cost visibility on the account's BYO
--                                    key. Written by the service role from
--                                    the draft route + auto-reply bot.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Mark AI-generated messages.
--
-- Auto-replies are inserted as sender_type='bot' (same as Flow sends);
-- this column is the only thing that distinguishes an LLM reply from a
-- deterministic one, so the inbox can show the "AI" badge on the right
-- bubbles only.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;

-- ============================================================
-- 2. Handoff routing target + 3. handoff summary.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_agent_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_summary text;

-- ============================================================
-- 4. Per-run token-usage log.
--
-- One row per LLM call (draft or auto-reply). Best-effort: the writer
-- never blocks a reply on a failed insert. Kept append-only; prune with
-- a scheduled job if it grows (an active account writes a handful of
-- rows per conversation).
--
-- RLS: admin+ read (spend is billing-class, not something a viewer/agent
-- needs). Writes come from the service-role client (webhook + route),
-- which bypasses RLS, so there is no INSERT policy for `authenticated`.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- 'auto_reply' | 'draft' — which surface spent the tokens.
  mode              text NOT NULL CHECK (mode IN ('auto_reply', 'draft')),
  provider          text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Account-scoped, newest-first reads (usage dashboards, "spend this
-- month") — the only access pattern.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_account_created
  ON ai_usage_log(account_id, created_at DESC);

ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;

-- SELECT: admin+ only (spend visibility is settings/billing-class).
DROP POLICY IF EXISTS ai_usage_log_select ON ai_usage_log;
CREATE POLICY ai_usage_log_select ON ai_usage_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policies for `authenticated`: the log is
-- written exclusively by the service role (webhook + draft route) and
-- is never mutated from the client.


-- ------------------------------------------------------------
-- 034_fix_profiles_update_rls.sql
-- ------------------------------------------------------------

-- ============================================================
-- 034_fix_profiles_update_rls.sql — lock down privilege columns
--                                    on profiles (GHSA-fg5p-2qc3-jmxr, C1)
--
-- NOTE: renamed from 031 → 034 to resolve a duplicate migration version.
-- The 031 slot was already taken by 031_ai_reply_slot_grant.sql (#345),
-- so shipping this as 031 too made a clean `supabase db` apply fail with
-- a duplicate schema_migrations key (SQLSTATE 23505). This migration is
-- idempotent (DROP POLICY IF EXISTS / CREATE OR REPLACE) and independent
-- of the AI tables, so re-sequencing it after 033 is safe.
--
-- The problem
--
--   The `profiles_update` RLS policy from migration 017 gates on
--   `auth.uid() = user_id` only — it lets a user edit their *own*
--   row, which is correct for self-service fields (full_name,
--   avatar). But `account_role` and `account_id` also live on
--   `profiles`, and they are the source of truth for
--   `is_account_member()`. RLS constrains *which rows* you may
--   update, not *which columns*, and no column-level GRANT or
--   trigger guards them. So the normal `authenticated` browser
--   client can self-serve a privilege escalation / tenant move:
--
--     -- viewer self-promotes to owner of the shared account
--     UPDATE profiles SET account_role = 'owner' WHERE user_id = auth.uid();
--     -- attacker relocates into a victim tenant
--     UPDATE profiles SET account_id = '<victim>' WHERE user_id = auth.uid();
--
--   Both pass the WITH CHECK because `user_id` is unchanged.
--
-- The fix
--
--   A BEFORE UPDATE trigger that rejects any change to
--   `account_role` / `account_id` when the caller is the
--   `authenticated` role (the browser). The legitimate writers are
--   unaffected:
--     - handle_new_user + the 018/019 member/invitation RPCs are
--       SECURITY DEFINER owned by `postgres`, so `current_user` is
--       `postgres`, not `authenticated`.
--     - the server backend runs as `service_role`.
--   Self-service edits that leave both columns untouched (the
--   IS DISTINCT FROM checks are false) also pass through freely.
--
--   Membership stays owned by the supervised RPCs (018/019), which
--   is exactly the model migration 018's header describes.
--
-- NOTE FOR MAINTAINER
--
--   `current_user` is the reliable discriminator here because every
--   sanctioned writer runs as postgres (DEFINER) or service_role,
--   and PostgREST's browser clients run as `authenticated`. If you
--   ever add a NON-definer RPC or a new role that must write these
--   columns, extend the guard's role check accordingly. Validate in
--   your own environment before relying on this (see the checks at
--   the bottom); this migration was not run against a live database.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- ============================================================
-- Manual validation (run against a live instance — no automated
-- SQL test harness exists in this repo):
--
--   1. As a viewer/member JWT via PostgREST, both of these must
--      return 42501 (insufficient_privilege):
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "account_role": "owner" }
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "account_id": "<other>" }
--   2. A self-service edit that leaves both columns alone must
--      still succeed:
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "full_name": "New Name" }
--   3. The member/invitation RPCs (set_member_role,
--      transfer_account_ownership, redeem_invitation) must still
--      succeed — they run SECURITY DEFINER as postgres.
-- ============================================================


-- ------------------------------------------------------------
-- 035_interactive_messages.sql
-- ------------------------------------------------------------

-- ============================================================
-- 035_interactive_messages.sql
--
-- Full support for WhatsApp interactive messages (reply buttons +
-- list messages) beyond the Flows subsystem.
--
--   1. messages.interactive_payload — the structured payload of an
--      OUTBOUND interactive message (buttons / list) so it round-trips:
--      the thread can re-render the buttons/rows we sent, not just the
--      body text. Migration 010 already added 'interactive' to the
--      content_type CHECK and the inbound `interactive_reply_id`
--      column, so no CHECK change is needed here.
--
--   2. quick_replies — reusable snippets (plain text OR a saved
--      interactive message) an agent can insert from the inbox
--      composer. Account-scoped, same tenancy model as automations.
-- ============================================================

-- 1. Outbound interactive payload -----------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS interactive_payload JSONB;

-- 2. Quick replies --------------------------------------------
CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Tenancy. Every member of the account shares its quick replies.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Author / audit only — never used for tenancy isolation.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- 'text' snippets carry `content_text`; 'interactive' snippets carry
  -- `interactive_payload` (validated app-side against Meta's limits).
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'interactive')),
  content_text TEXT,
  interactive_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id);

ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;

-- Account-scoped policies mirroring automations (see 017): any member
-- can read; agent+ can create / edit / delete.
DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;
CREATE POLICY quick_replies_select ON quick_replies FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON quick_replies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON quick_replies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ------------------------------------------------------------
-- 036_conversation_contact_dedup.sql
-- ------------------------------------------------------------

-- ============================================================
-- 036_conversation_contact_dedup
--
-- Prevent the same contact from fragmenting into multiple
-- conversations within one account (issue #363).
--
-- The inbound webhook and the public-API resolver both follow a
-- "one conversation per (account, contact)" convention, but that
-- convention was only ever enforced in application code with a
-- `.single()` / `.maybeSingle()` lookup and no DB constraint. Two
-- problems compounded:
--
--   1. A race (Meta retries a delivery, or a batch delivers two
--      messages that fan out to concurrent `after()` runs) let two
--      inserts both miss the lookup and create two conversations —
--      unlike contacts (migration 022) there was no unique index and
--      no unique-violation backstop.
--   2. Once ≥2 conversations existed for a contact, the `.single()`
--      lookup errored on *every* subsequent inbound message, so the
--      code fell through and created yet another conversation each
--      time — the duplication snowballed, which is what the reporter
--      saw (a wall of duplicate chats for one number).
--
-- This migration mirrors 022_contact_phone_dedup:
--   1. merges existing duplicate conversations into the oldest row,
--      re-pointing every conversation-scoped child first so nothing
--      is lost;
--   2. adds a UNIQUE index on (account_id, contact_id) — the
--      authoritative guarantee that covers every write path.
--
-- Idempotent. **No data loss** — duplicate conversations are merged,
-- not dropped: child rows (messages, message_reactions, deals,
-- flow_runs, notifications, ai_usage_log) are re-pointed to the
-- surviving (oldest) conversation before the losers are deleted.
-- ============================================================

-- 1) One-time (re-runnable) merge of existing duplicates.
--    SECURITY DEFINER so it can re-point rows across tables
--    regardless of the caller's RLS; it only ever collapses
--    conversations that share the same (account_id, contact_id).
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    -- Re-point every conversation-scoped child from the losers onto
    -- the survivor. None of these carry a conversation-scoped unique
    -- constraint (message_id is intentionally non-unique — see
    -- migration 009), so a plain UPDATE is safe. Doing this BEFORE the
    -- delete is what saves the ON DELETE CASCADE children (messages,
    -- message_reactions, notifications) from being removed with the
    -- loser conversations.
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    -- Roll the merged unread counts onto the survivor and re-derive
    -- its last-message summary from the now-complete message set, so
    -- the surviving thread reflects the full history.
    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    -- Survivor may have no messages at all (edge case). Still fold in
    -- the merged unread count in that case.
    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- Collapse whatever duplicates exist right now.
SELECT public.merge_duplicate_conversations();

-- 2) Authoritative guarantee: one conversation per (account, contact).
--    Every write path (inbound webhook, public-API resolver) now has a
--    DB-level backstop, and its unique-violation handling can re-resolve
--    the winning row instead of compounding duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);


-- ------------------------------------------------------------
-- 037_webhook_broadcast_reliability.sql
-- ------------------------------------------------------------

-- ============================================================
-- 037_webhook_broadcast_reliability
--
-- Three independent reliability fixes that all need a DB-level
-- guarantee the application layer can't provide on its own:
--
--   #367  Inbound-webhook idempotency. Meta retries webhook
--         deliveries; an unconditional message INSERT persisted the
--         same inbound message twice and re-ran every downstream
--         side effect. A unique index on (conversation_id,
--         message_id) turns a replay into an ON CONFLICT no-op.
--
--   #369  Concurrent inbound messages lost unread-count increments.
--         The webhook did a read-modify-write of unread_count, so
--         two concurrent deliveries for one conversation both read N
--         and both wrote N+1. Moved to a DB-side atomic increment
--         (mirrors migration 007's automation-counter fix).
--
--   #370  Broadcast creation persisted the parent row before the
--         recipients, leaving an orphaned `sending` broadcast with
--         no recipients when the recipient insert failed. A single
--         function runs both inserts in one transaction, so a
--         recipient failure rolls the parent back.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- #367 — inbound webhook idempotency
--
-- The Meta message id is unique per receiving number, and a given
-- (account, contact) always resolves to the same conversation
-- (guaranteed by migration 036), so (conversation_id, message_id)
-- is the correct idempotency key — `message_id` alone is NOT
-- globally unique across phone numbers (see migration 009).
--
-- A plain (non-partial) unique index is used deliberately so
-- PostgREST's `ON CONFLICT` arbiter inference works from the column
-- list alone. NULL `message_id`s (outbound rows mid-send, before the
-- Meta wamid lands) are treated as distinct by a standard unique
-- index, so they never collide with each other.
-- ============================================================

-- Collapse pre-existing duplicates (keep the earliest row per key —
-- it's the one whose downstream side effects already ran) so the
-- unique index can be created. Only rows with a non-NULL message_id
-- can collide. reply_to_message_id is ON DELETE SET NULL (migration
-- 009) and reactions cascade, so removing a strict duplicate is safe.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id, message_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM messages
  WHERE message_id IS NOT NULL
)
DELETE FROM messages m
USING ranked r
WHERE m.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id
  ON messages (conversation_id, message_id);

-- ============================================================
-- #369 — atomic unread-count increment on inbound
--
-- Replaces the webhook's read-modify-write. The increment happens
-- entirely inside the UPDATE so concurrent inbound deliveries for
-- the same conversation can't lose each other's bump. Also refreshes
-- the last-message summary in the same statement (matching the old
-- code's semantics: last_message_at = now, not the Meta timestamp).
-- ============================================================
CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      updated_at        = NOW()
  WHERE id = p_conversation_id;
$$;

-- Only the service role (webhook) calls this. Lock everyone else out
-- so an authenticated user can't bump another account's unread count.
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) TO service_role;

-- ============================================================
-- #370 — atomic broadcast creation
--
-- Inserts the parent `broadcasts` row and all `broadcast_recipients`
-- rows in a single transaction (a function body is atomic), then
-- returns the created ids so the caller can build its send plan. If
-- the recipient insert fails, the parent insert rolls back and no
-- orphaned `sending` broadcast survives.
--
-- Per-status count columns are intentionally NOT seeded — they're
-- owned by the aggregate trigger (migrations 003/005), same as the
-- previous application-side insert.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id       UUID,
  p_user_id          UUID,
  p_name             TEXT,
  p_template_name    TEXT,
  p_template_language TEXT,
  p_total_recipients INTEGER,
  p_contact_ids      UUID[]
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

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (broadcast_id, contact_id, status)
    SELECT v_broadcast_id, cid, 'pending'
    FROM unnest(p_contact_ids) AS cid
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]) TO service_role;
