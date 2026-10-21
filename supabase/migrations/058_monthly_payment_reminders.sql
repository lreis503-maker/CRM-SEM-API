-- ============================================================
-- 058 — Avisos mensais de pagamento pelo WhatsApp
-- ============================================================

CREATE TABLE IF NOT EXISTS monthly_payment_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('contact', 'manual')),
  -- Sem FK de propósito: se o contato for apagado, o executor precisa
  -- encontrar a ausência e registrar a falha, não trocar de destinatário.
  contact_id UUID,
  recipient_name TEXT,
  recipient_phone TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  send_day SMALLINT NOT NULL CHECK (send_day BETWEEN 1 AND 31),
  send_time TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_payment_recipient_shape CHECK (
    (recipient_kind = 'contact' AND contact_id IS NOT NULL)
    OR
    (recipient_kind = 'manual'
      AND contact_id IS NULL
      AND NULLIF(BTRIM(recipient_name), '') IS NOT NULL
      AND recipient_phone ~ '^[1-9][0-9]{7,14}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_monthly_payment_reminders_due
  ON monthly_payment_reminders (account_id, enabled, deleted_at)
  WHERE enabled AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_monthly_payment_reminders_contact
  ON monthly_payment_reminders (account_id, contact_id)
  WHERE contact_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS monthly_payment_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID NOT NULL REFERENCES monthly_payment_reminders(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  competence DATE NOT NULL CHECK (competence = date_trunc('month', competence)::date),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processing_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  recipient_name TEXT,
  recipient_phone TEXT,
  message TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reminder_id, competence)
);

CREATE INDEX IF NOT EXISTS idx_monthly_payment_deliveries_claim
  ON monthly_payment_deliveries (status, next_attempt_at, processing_at, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_monthly_payment_deliveries_account
  ON monthly_payment_deliveries (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monthly_payment_scheduler_lease (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  locked_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  holder TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO monthly_payment_scheduler_lease (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE monthly_payment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_payment_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_payment_scheduler_lease ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monthly_payment_reminders_select ON monthly_payment_reminders;
CREATE POLICY monthly_payment_reminders_select
  ON monthly_payment_reminders FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS monthly_payment_deliveries_select ON monthly_payment_deliveries;
CREATE POLICY monthly_payment_deliveries_select
  ON monthly_payment_deliveries FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Cria a competência vencida e reivindica um lote em uma única transação.
-- A unicidade impede dois inserts do mesmo mês; SKIP LOCKED impede dois
-- processos de receberem a mesma entrega.
CREATE OR REPLACE FUNCTION public.claim_due_monthly_payment_deliveries(
  p_now TIMESTAMPTZ,
  p_limit INTEGER,
  p_holder TEXT
) RETURNS TABLE (
  delivery_id UUID,
  claimed_reminder_id UUID,
  claimed_account_id UUID,
  claimed_competence DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH due_reminders AS (
    SELECT
      r.id AS reminder_id,
      r.account_id,
      date_trunc('month', p_now AT TIME ZONE r.timezone)::date AS competence,
      make_timestamptz(
        EXTRACT(YEAR FROM p_now AT TIME ZONE r.timezone)::integer,
        EXTRACT(MONTH FROM p_now AT TIME ZONE r.timezone)::integer,
        LEAST(
          r.send_day,
          EXTRACT(
            DAY FROM (
              date_trunc('month', p_now AT TIME ZONE r.timezone)
              + interval '1 month - 1 day'
            )
          )::integer
        ),
        EXTRACT(HOUR FROM r.send_time)::integer,
        EXTRACT(MINUTE FROM r.send_time)::integer,
        0,
        r.timezone
      ) AS scheduled_for
    FROM monthly_payment_reminders r
    WHERE r.enabled
      AND r.deleted_at IS NULL
  ), inserted AS (
    INSERT INTO monthly_payment_deliveries (
      reminder_id,
      account_id,
      competence,
      scheduled_for,
      status,
      next_attempt_at
    )
    SELECT
      d.reminder_id,
      d.account_id,
      d.competence,
      d.scheduled_for,
      'pending',
      p_now
    FROM due_reminders d
    JOIN monthly_payment_reminders r ON r.id = d.reminder_id
    WHERE d.scheduled_for <= p_now
      AND r.starts_at <= d.scheduled_for
    ON CONFLICT (reminder_id, competence) DO NOTHING
    RETURNING id
  ), claimable AS (
    SELECT d.id
    FROM monthly_payment_deliveries d
    JOIN monthly_payment_reminders r ON r.id = d.reminder_id
    WHERE r.enabled
      AND r.deleted_at IS NULL
      AND d.competence = date_trunc('month', p_now AT TIME ZONE r.timezone)::date
      AND d.scheduled_for <= p_now
      AND (
        d.status = 'pending'
        OR (d.status = 'failed' AND d.next_attempt_at <= p_now)
        OR (d.status = 'processing' AND d.processing_at < p_now - interval '10 minutes')
      )
    ORDER BY d.scheduled_for, d.created_at
    FOR UPDATE OF d SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
  ), claimed AS (
    UPDATE monthly_payment_deliveries d
    SET status = 'processing',
        attempts = d.attempts + 1,
        processing_at = p_now,
        updated_at = p_now,
        last_error = NULL
    FROM claimable c
    WHERE d.id = c.id
    RETURNING d.id, d.reminder_id, d.account_id, d.competence
  )
  SELECT c.id, c.reminder_id, c.account_id, c.competence
  FROM claimed c;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_monthly_payment_deliveries(TIMESTAMPTZ, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_monthly_payment_deliveries(TIMESTAMPTZ, INTEGER, TEXT)
  TO service_role;
