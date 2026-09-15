-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- UAZAPI instance tokens must never inherit whatsapp_config's
  -- account-member SELECT policy. Migration 043 keeps the single
  -- account configuration row but moves its encrypted provider secret
  -- into a one-to-one table with RLS and no browser policies.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'uazapi_instance_token'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config exposes uazapi_instance_token to account-member SELECT';
  END IF;

  IF to_regclass('public.whatsapp_config_secrets') IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_config_secrets is missing — UAZAPI credentials have no server-only storage';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config_secrets'
      AND column_name = 'uazapi_instance_token' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_secrets.uazapi_instance_token must exist and be required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config_secrets'::regclass
      AND conname = 'whatsapp_config_secrets_uazapi_instance_token_encrypted_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_secrets must reject non-GCM UAZAPI token values';
  END IF;

  IF NOT (
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'public.whatsapp_config_secrets'::regclass
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_secrets must have row-level security enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'whatsapp_config_secrets'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_secrets must not expose credentials through browser policies';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
