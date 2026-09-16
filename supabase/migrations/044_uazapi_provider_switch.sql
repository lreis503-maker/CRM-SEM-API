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
