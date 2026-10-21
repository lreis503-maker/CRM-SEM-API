-- ============================================================
-- 059 — Painel de prospecção fria
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cold_prospects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
  assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  instagram TEXT,
  whatsapp TEXT,
  company TEXT,
  niche TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'replied', 'interested', 'no_response', 'not_interested')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_contact_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cold_prospects_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT cold_prospects_has_channel CHECK (
    NULLIF(trim(instagram), '') IS NOT NULL OR NULLIF(trim(whatsapp), '') IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_cold_prospects_account_status
  ON public.cold_prospects (account_id, status);
CREATE INDEX IF NOT EXISTS idx_cold_prospects_account_follow_up
  ON public.cold_prospects (account_id, next_follow_up_at);
CREATE INDEX IF NOT EXISTS idx_cold_prospects_assigned_to
  ON public.cold_prospects (assigned_to);

DROP TRIGGER IF EXISTS set_cold_prospects_updated_at ON public.cold_prospects;
CREATE TRIGGER set_cold_prospects_updated_at
  BEFORE UPDATE ON public.cold_prospects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.cold_prospects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cold_prospects_select ON public.cold_prospects;
DROP POLICY IF EXISTS cold_prospects_insert ON public.cold_prospects;
DROP POLICY IF EXISTS cold_prospects_update ON public.cold_prospects;
DROP POLICY IF EXISTS cold_prospects_delete ON public.cold_prospects;

CREATE POLICY cold_prospects_select ON public.cold_prospects FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY cold_prospects_insert ON public.cold_prospects FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
  );
CREATE POLICY cold_prospects_update ON public.cold_prospects FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY cold_prospects_delete ON public.cold_prospects FOR DELETE
  USING (public.is_account_member(account_id, 'agent'));

