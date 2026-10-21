-- ============================================================
-- CRM - BANCO DE DADOS - PARTE 5 DE 5
--
-- Cole ESTE arquivo inteiro no SQL Editor do Supabase e clique
-- em Run. Depois volte e faca o mesmo com a parte (acabou).
--
-- IMPORTANTE: rode as partes NA ORDEM, da 1 ate a 5.
--
-- Contem: 053_lead_ownership_round_robin.sql ate 058_monthly_payment_reminders.sql
--
-- E seguro rodar de novo se voce se perder: tudo aqui usa
-- IF NOT EXISTS ou DROP ... IF EXISTS, entao repetir uma parte
-- nao apaga dados nem quebra nada.
-- ============================================================

-- ------------------------------------------------------------
-- 053_lead_ownership_round_robin.sql
-- ------------------------------------------------------------

-- ============================================================
-- 053_lead_ownership_round_robin
--
-- Dono da conversa, roleta de leads e transferência.
--
-- 1. VISIBILIDADE
--    O atendente (account_role = 'agent') só enxerga as conversas
--    atribuídas a ele. Proprietário, administrador e visualizador
--    continuam enxergando todas. As mensagens e reações seguem a
--    mesma regra, porque as regras delas já consultam a tabela de
--    conversas (e o banco aplica a regra da conversa ali também).
--    Conversa sem dono fica só com o adm, até a roleta ou o adm
--    entregar para alguém.
--
-- 2. ROLETA
--    profiles.round_robin_enabled — o adm decide quem participa.
--    profiles.is_available        — o próprio usuário (ou o adm)
--                                   marca "indisponível" na folga.
--    assign_next_round_robin_agent() entrega a conversa para o
--    próximo da fila, em rodízio. Chamada pelo servidor quando chega
--    a mensagem de um lead novo (grupos não entram).
--
-- 3. TRANSFERÊNCIA
--    transfer_conversation() passa o lead para outro usuário e leva
--    junto os negócios abertos daquele contato.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- Colunas da roleta
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'round_robin_enabled'
  ) THEN
    ALTER TABLE profiles
      ADD COLUMN round_robin_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    -- Só na primeira vez: atendentes entram na roleta, adm e
    -- proprietário não. Depois disso quem decide é o adm.
    UPDATE profiles SET round_robin_enabled = (account_role = 'agent');
  END IF;
END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN profiles.round_robin_enabled IS
  'Participa da roleta de leads. Alterado pelo adm (set_member_round_robin). Migração 053.';
COMMENT ON COLUMN profiles.is_available IS
  'FALSE = indisponível (folga/ausente): a roleta pula este usuário. Migração 053.';

-- As duas colunas só mudam pelas funções abaixo, que conferem quem
-- pode mudar o quê. Sem isso, qualquer usuário poderia se colocar
-- ou se tirar da roleta editando o próprio perfil.
CREATE OR REPLACE FUNCTION public.enforce_profile_round_robin_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.round_robin_enabled IS DISTINCT FROM OLD.round_robin_enabled
      OR NEW.is_available IS DISTINCT FROM OLD.is_available)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'round_robin_enabled and is_available change only through set_member_round_robin / set_member_availability'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_profile_round_robin_columns ON public.profiles;
CREATE TRIGGER enforce_profile_round_robin_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_round_robin_columns();

-- ------------------------------------------------------------
-- Quem pode ver uma conversa
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_conversation(
  p_account_id UUID,
  p_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM profiles p
     WHERE p.user_id = auth.uid()
       AND p.account_id = p_account_id
       AND (
         p.account_role IN ('owner', 'admin', 'viewer')
         OR (p_assigned_agent_id IS NOT NULL
             AND p_assigned_agent_id = auth.uid())
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_access_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID, UUID)
  TO authenticated, service_role;

DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_conversation(account_id, assigned_agent_id));

-- USING: só mexe em conversa que enxerga. WITH CHECK: o resultado
-- pode ficar com outra pessoa — é isso que permite transferir.
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_conversation(account_id, assigned_agent_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_conversation(account_id, assigned_agent_id)
  );

-- Conversa aberta por um atendente (pela lista de contatos) já nasce
-- dele; sem isso ela sumiria da tela dele no mesmo instante.
CREATE OR REPLACE FUNCTION public.default_conversation_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL AND auth.uid() IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM profiles
       WHERE user_id = auth.uid()
         AND account_id = NEW.account_id
         AND account_role = 'agent'
    ) THEN
      NEW.assigned_agent_id := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS default_conversation_owner ON conversations;
CREATE TRIGGER default_conversation_owner
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.default_conversation_owner();

-- ------------------------------------------------------------
-- Roleta
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_rotation_state (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE lead_rotation_state ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE lead_rotation_state IS
  'Último usuário que recebeu lead pela roleta, por conta. Sem policies: só o servidor lê e grava. Migração 053.';

/**
 * Entrega a conversa ao próximo usuário da roleta.
 *
 * Devolve o user_id escolhido, ou NULL quando a conversa já tem dono,
 * é de um grupo, ou ninguém está disponível (aí ela fica com o adm).
 * A trava na linha de estado da conta garante que dois leads chegando
 * juntos não caiam na mesma pessoa por engano.
 */
CREATE OR REPLACE FUNCTION public.assign_next_round_robin_agent(
  p_conversation_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_assigned UUID;
  v_is_group BOOLEAN;
  v_last UUID;
  v_last_created TIMESTAMPTZ;
  v_next UUID;
BEGIN
  SELECT c.account_id, c.assigned_agent_id, COALESCE(ct.is_group, FALSE)
    INTO v_account_id, v_assigned, v_is_group
    FROM conversations c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
   WHERE c.id = p_conversation_id
   FOR UPDATE OF c;

  IF v_account_id IS NULL OR v_assigned IS NOT NULL OR v_is_group THEN
    RETURN NULL;
  END IF;

  INSERT INTO lead_rotation_state (account_id)
  VALUES (v_account_id)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT last_user_id INTO v_last
    FROM lead_rotation_state
   WHERE account_id = v_account_id
   FOR UPDATE;

  SELECT created_at INTO v_last_created
    FROM profiles
   WHERE user_id = v_last AND account_id = v_account_id;

  -- O próximo depois do último que recebeu; se ninguém vier depois,
  -- volta para o primeiro da fila.
  SELECT p.user_id INTO v_next
    FROM profiles p
   WHERE p.account_id = v_account_id
     AND p.round_robin_enabled
     AND p.is_available
     AND p.account_role IN ('owner', 'admin', 'agent')
   ORDER BY
     CASE
       WHEN v_last_created IS NULL THEN 0
       WHEN (p.created_at, p.user_id) > (v_last_created, v_last) THEN 0
       ELSE 1
     END,
     p.created_at,
     p.user_id
   LIMIT 1;

  IF v_next IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE conversations
     SET assigned_agent_id = v_next,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  UPDATE lead_rotation_state
     SET last_user_id = v_next,
         updated_at = NOW()
   WHERE account_id = v_account_id;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_next_round_robin_agent(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_next_round_robin_agent(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_next_round_robin_agent(UUID) TO service_role;

-- ------------------------------------------------------------
-- Disponibilidade e participação na roleta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_availability(
  p_user_id UUID,
  p_available BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- A própria pessoa, ou um adm da mesma conta.
  IF p_user_id IS DISTINCT FROM auth.uid()
     AND NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE profiles SET is_available = p_available WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_availability(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_availability(UUID, BOOLEAN)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_member_round_robin(
  p_user_id UUID,
  p_enabled BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE profiles SET round_robin_enabled = p_enabled WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_round_robin(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_round_robin(UUID, BOOLEAN)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Transferência
-- ------------------------------------------------------------
/**
 * Passa a conversa para outro usuário (ou devolve para o adm, com
 * p_to_user_id NULL) e leva junto os negócios abertos do contato.
 *
 * Quem chama precisa enxergar a conversa: o atendente só transfere o
 * que é dele; o adm transfere qualquer uma.
 */
CREATE OR REPLACE FUNCTION public.transfer_conversation(
  p_conversation_id UUID,
  p_to_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_assigned UUID;
  v_contact_id UUID;
  v_target_profile_id UUID;
BEGIN
  SELECT account_id, assigned_agent_id, contact_id
    INTO v_account_id, v_assigned, v_contact_id
    FROM conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF v_account_id IS NULL
     OR NOT is_account_member(v_account_id, 'agent')
     OR NOT can_access_conversation(v_account_id, v_assigned) THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_to_user_id IS NOT NULL THEN
    SELECT id INTO v_target_profile_id
      FROM profiles
     WHERE user_id = p_to_user_id AND account_id = v_account_id;
    IF v_target_profile_id IS NULL THEN
      RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  UPDATE conversations
     SET assigned_agent_id = p_to_user_id,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  -- Os negócios abertos do mesmo contato acompanham o lead.
  UPDATE deals
     SET assigned_to = v_target_profile_id,
         updated_at = NOW()
   WHERE account_id = v_account_id
     AND status = 'open'
     AND (conversation_id = p_conversation_id
          OR (v_contact_id IS NOT NULL AND contact_id = v_contact_id));
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_conversation(UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Aviso de lead recebido, em português
-- ------------------------------------------------------------
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
    CASE WHEN auth.uid() IS NULL THEN 'Novo lead para você'
         ELSE 'Lead transferido para você' END,
    CASE WHEN auth.uid() IS NULL
         THEN 'A roleta enviou o lead ' || COALESCE(v_contact_name, 'sem nome') || ' para você.'
         ELSE COALESCE(v_actor_name, 'Alguém') || ' passou o lead '
              || COALESCE(v_contact_name, 'sem nome') || ' para você.'
    END
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- 054_lead_ownership_contacts_deals.sql
-- ------------------------------------------------------------

-- ============================================================
-- 054 — Vendedor vê só os próprios contatos e negociações
-- ============================================================
--
-- Continuação da 053. Lá as conversas passaram a ser de quem está
-- atendendo; aqui Contatos e Pipeline seguem a mesma regra.
--
-- Dono, administrador e visualizador continuam vendo tudo.
--
-- O atendente (vendedor) vê um CONTATO quando:
--   • tem uma conversa com esse contato atribuída a ele; ou
--   • tem uma negociação desse contato atribuída a ele; ou
--   • foi ele quem cadastrou o contato (manual ou importação).
--
-- O atendente vê uma NEGOCIAÇÃO quando:
--   • ela está atribuída a ele; ou
--   • ela não tem responsável e foi ele quem criou, ou a conversa
--     desse contato está com ele.
--
-- Para que nada "suma", negociações sem responsável passam a herdar o
-- dono da conversa:
--   • ao criar a negociação (formulário, automação ou API);
--   • quando a roleta ou alguém atribui/transfere a conversa;
--   • uma vez agora, para as negociações abertas que já existem.
--
-- Notas do contato, etiquetas e campos personalizados seguem o contato.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

-- Índices para as checagens abaixo ficarem rápidas.
CREATE INDEX IF NOT EXISTS idx_conversations_contact_agent
  ON conversations (contact_id, assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id
  ON deals (contact_id);

-- ------------------------------------------------------------
-- Quem pode ver um contato
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_contact(
  p_account_id UUID,
  p_contact_id UUID,
  p_created_by UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_profile UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p.account_role::text, p.id
    INTO v_role, v_profile
    FROM profiles p
   WHERE p.user_id = v_uid
     AND p.account_id = p_account_id;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role IN ('owner', 'admin', 'viewer') THEN
    RETURN TRUE;
  END IF;
  IF p_created_by = v_uid THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
           SELECT 1 FROM conversations c
            WHERE c.contact_id = p_contact_id
              AND c.assigned_agent_id = v_uid
         )
      OR EXISTS (
           SELECT 1 FROM deals d
            WHERE d.contact_id = p_contact_id
              AND d.assigned_to = v_profile
         );
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_contact(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_contact(UUID, UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Quem pode ver uma negociação
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_deal(
  p_account_id UUID,
  p_assigned_to UUID,
  p_created_by UUID,
  p_contact_id UUID,
  p_conversation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_profile UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p.account_role::text, p.id
    INTO v_role, v_profile
    FROM profiles p
   WHERE p.user_id = v_uid
     AND p.account_id = p_account_id;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role IN ('owner', 'admin', 'viewer') THEN
    RETURN TRUE;
  END IF;

  -- Com responsável: só o responsável.
  IF p_assigned_to IS NOT NULL THEN
    RETURN p_assigned_to = v_profile;
  END IF;

  -- Sem responsável: quem criou, ou quem está com a conversa.
  IF p_created_by = v_uid THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.assigned_agent_id = v_uid
       AND (c.id = p_conversation_id OR c.contact_id = p_contact_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_deal(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_deal(UUID, UUID, UUID, UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Políticas: contatos
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;

CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_access_contact(account_id, id, user_id));

CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact(account_id, id, user_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact(account_id, id, user_id)
  );

-- Contato cadastrado por um atendente fica registrado no nome dele,
-- senão ele sumiria da lista dele assim que fosse salvo.
CREATE OR REPLACE FUNCTION public.default_contact_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- auth.uid() só existe para quem está logado no CRM; servidor,
  -- automações e API chegam sem ele e ficam como estão.
  IF auth.uid() IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_id = NEW.account_id
         AND p.account_role::text = 'agent'
    ) THEN
      NEW.user_id := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_contact_creator ON contacts;
CREATE TRIGGER trg_default_contact_creator
  BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.default_contact_creator();

-- ------------------------------------------------------------
-- Políticas: negociações
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON deals;
DROP POLICY IF EXISTS deals_update ON deals;
DROP POLICY IF EXISTS deals_delete ON deals;

CREATE POLICY deals_select ON deals FOR SELECT
  USING (can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id));

-- USING: só mexe no que enxerga. WITH CHECK: pode passar para outra
-- pessoa (trocar o responsável é uma transferência).
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY deals_delete ON deals FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id)
  );

-- Trocar o responsável de uma negociação. Precisa ser uma função porque,
-- para o atendente, a negociação deixa de ser visível no mesmo instante
-- e o banco recusaria a edição comum. Quem chama precisa enxergar a
-- negociação; o novo responsável precisa ser da mesma conta (ou NULL
-- para deixar sem responsável).
CREATE OR REPLACE FUNCTION public.transfer_deal(
  p_deal_id UUID,
  p_to_profile_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deal deals%ROWTYPE;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT is_account_member(v_deal.account_id, 'agent')
     OR NOT can_access_deal(v_deal.account_id, v_deal.assigned_to,
                            v_deal.user_id, v_deal.contact_id,
                            v_deal.conversation_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF p_to_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.id = p_to_profile_id
       AND p.account_id = v_deal.account_id
  ) THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = '22023';
  END IF;

  UPDATE deals
     SET assigned_to = p_to_profile_id,
         updated_at = NOW()
   WHERE id = p_deal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_deal(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_deal(UUID, UUID)
  TO authenticated, service_role;

-- Negociação criada sem responsável:
--   • criada por um atendente → fica com ele;
--   • criada por admin, automação ou API → fica com quem está com a
--     conversa do contato, se houver.
CREATE OR REPLACE FUNCTION public.default_deal_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile UUID;
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT p.id INTO v_profile
      FROM profiles p
     WHERE p.user_id = auth.uid()
       AND p.account_id = NEW.account_id
       AND p.account_role::text = 'agent';
  END IF;

  IF v_profile IS NULL THEN
    SELECT p.id INTO v_profile
      FROM conversations c
      JOIN profiles p
        ON p.user_id = c.assigned_agent_id
       AND p.account_id = NEW.account_id
     WHERE c.account_id = NEW.account_id
       AND c.assigned_agent_id IS NOT NULL
       AND (
         c.id = NEW.conversation_id
         OR (NEW.contact_id IS NOT NULL AND c.contact_id = NEW.contact_id)
       )
     ORDER BY (c.id = NEW.conversation_id) DESC NULLS LAST,
              c.last_message_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  NEW.assigned_to := v_profile;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_deal_owner ON deals;
CREATE TRIGGER trg_default_deal_owner
  BEFORE INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION public.default_deal_owner();

-- Conversa recebeu dono (roleta, atribuição ou transferência):
-- negociações abertas e sem responsável desse contato vão junto.
CREATE OR REPLACE FUNCTION public.sync_open_deals_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile UUID;
BEGIN
  IF NEW.assigned_agent_id IS NULL OR NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT p.id INTO v_profile
    FROM profiles p
   WHERE p.user_id = NEW.assigned_agent_id
     AND p.account_id = NEW.account_id;

  IF v_profile IS NOT NULL THEN
    UPDATE deals
       SET assigned_to = v_profile,
           updated_at = NOW()
     WHERE account_id = NEW.account_id
       AND contact_id = NEW.contact_id
       AND status = 'open'
       AND assigned_to IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_open_deals_owner ON conversations;
CREATE TRIGGER trg_sync_open_deals_owner
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.sync_open_deals_owner();

-- Uma vez agora: negociações abertas sem responsável herdam o dono da
-- conversa mais recente do contato.
UPDATE deals d
   SET assigned_to = owner.profile_id,
       updated_at = NOW()
  FROM (
    SELECT DISTINCT ON (c.account_id, c.contact_id)
           c.account_id, c.contact_id, p.id AS profile_id
      FROM conversations c
      JOIN profiles p
        ON p.user_id = c.assigned_agent_id
       AND p.account_id = c.account_id
     WHERE c.assigned_agent_id IS NOT NULL
       AND c.contact_id IS NOT NULL
     ORDER BY c.account_id, c.contact_id, c.last_message_at DESC NULLS LAST
  ) owner
 WHERE d.account_id = owner.account_id
   AND d.contact_id = owner.contact_id
   AND d.status = 'open'
   AND d.assigned_to IS NULL;

-- ------------------------------------------------------------
-- Notas do contato seguem o contato
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
DROP POLICY IF EXISTS contact_notes_insert ON contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;

CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_insert ON contact_notes FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );

-- Etiquetas e campos personalizados já consultam `contacts` nas próprias
-- políticas, então passam a seguir a mesma regra automaticamente.


-- ------------------------------------------------------------
-- 055_inbox_filters_and_per_user_unread.sql
-- ------------------------------------------------------------

-- ============================================================
-- 055 — Filtros da caixa de entrada e "não lida" por pessoa
-- ============================================================
--
-- 1. Aguardando resposta
--    `conversations.last_message_sender` guarda quem mandou a última
--    mensagem ('customer', 'agent' ou 'bot'). Quando é 'customer', a
--    conversa está esperando resposta. Mantido por gatilho em
--    `messages`, então vale para tudo: webhook, CRM, celular, robô,
--    importação de histórico (mensagem antiga não sobrescreve a nova).
--
-- 2. Bolinha azul separada para quem é dono e para o administrador
--    • `unread_count` continua sendo o contador do responsável pela
--      conversa (o vendedor; ou a equipe, se ainda não tem dono).
--      Zera quando o responsável abre a conversa no CRM ou lê no
--      celular.
--    • Quem olha a conversa de outra pessoa (admin, dono, visualizador)
--      tem a própria marca de leitura em `conversation_reads`. A
--      contagem dessa pessoa vem de `my_unread_counts()`.
--
-- 3. Lido no celular
--    O CRM nunca envia confirmação de leitura; então, quando o WhatsApp
--    avisa que uma mensagem do cliente foi lida, foi alguém no celular
--    da empresa. `apply_phone_read()` baixa o contador do responsável
--    para as mensagens que chegaram depois da que foi lida.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_sender TEXT,
  ADD COLUMN IF NOT EXISTS last_message_sender_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

-- ------------------------------------------------------------
-- Quem mandou a última mensagem
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_conversation_last_sender()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at TIMESTAMPTZ := COALESCE(NEW.created_at, NOW());
BEGIN
  UPDATE conversations c
     SET last_message_sender = CASE
           WHEN c.last_message_sender_at IS NULL
             OR v_at >= c.last_message_sender_at
           THEN NEW.sender_type
           ELSE c.last_message_sender
         END,
         last_message_sender_at = GREATEST(
           COALESCE(c.last_message_sender_at, v_at), v_at
         ),
         last_inbound_at = CASE
           WHEN NEW.sender_type = 'customer'
           THEN GREATEST(COALESCE(c.last_inbound_at, v_at), v_at)
           ELSE c.last_inbound_at
         END
   WHERE c.id = NEW.conversation_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_conversation_last_sender ON messages;
CREATE TRIGGER trg_track_conversation_last_sender
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.track_conversation_last_sender();

-- Preenche as conversas que já existem.
UPDATE conversations c
   SET last_message_sender = m.sender_type,
       last_message_sender_at = m.created_at
  FROM (
    SELECT DISTINCT ON (conversation_id)
           conversation_id, sender_type, created_at
      FROM messages
     ORDER BY conversation_id, created_at DESC
  ) m
 WHERE m.conversation_id = c.id
   AND c.last_message_sender IS NULL;

UPDATE conversations c
   SET last_inbound_at = m.last_at
  FROM (
    SELECT conversation_id, MAX(created_at) AS last_at
      FROM messages
     WHERE sender_type = 'customer'
     GROUP BY conversation_id
  ) m
 WHERE m.conversation_id = c.id
   AND c.last_inbound_at IS NULL;

-- ------------------------------------------------------------
-- Marca de leitura por pessoa
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_reads_select ON conversation_reads;
CREATE POLICY conversation_reads_select ON conversation_reads FOR SELECT
  USING (user_id = auth.uid());
-- Escrita só pelas funções abaixo.

-- A partir de quando contar "não lidas" para quem nunca abriu a
-- conversa: a data desta migração para quem já existe, a data de
-- entrada para quem chegar depois. Evita que o admin comece com
-- centenas de mensagens antigas marcadas como não lidas.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS unread_since TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.mark_conversation_read(
  p_conversation_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_assigned UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, assigned_agent_id
    INTO v_account, v_assigned
    FROM conversations
   WHERE id = p_conversation_id;

  IF NOT FOUND OR NOT can_access_conversation(v_account, v_assigned) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
  VALUES (auth.uid(), p_conversation_id, NOW())
  ON CONFLICT (user_id, conversation_id)
  DO UPDATE SET last_read_at = GREATEST(conversation_reads.last_read_at,
                                        EXCLUDED.last_read_at);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID)
  TO authenticated;

-- Mensagens do cliente que a pessoa logada ainda não viu, por conversa.
-- Só devolve conversas com alguma não lida.
CREATE OR REPLACE FUNCTION public.my_unread_counts()
RETURNS TABLE (conversation_id UUID, unread BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id, p.unread_since
      FROM profiles p
     WHERE p.user_id = auth.uid()
  )
  SELECT c.id, COUNT(m.id)
    FROM me
    JOIN conversations c
      ON c.account_id = me.account_id
    LEFT JOIN conversation_reads r
      ON r.conversation_id = c.id
     AND r.user_id = auth.uid()
    JOIN messages m
      ON m.conversation_id = c.id
     AND m.sender_type = 'customer'
     AND m.created_at > COALESCE(r.last_read_at, me.unread_since)
   WHERE c.last_inbound_at > COALESCE(r.last_read_at, me.unread_since)
     AND can_access_conversation(c.account_id, c.assigned_agent_id)
   GROUP BY c.id;
$$;

REVOKE ALL ON FUNCTION public.my_unread_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_unread_counts() TO authenticated;

-- ------------------------------------------------------------
-- Lido no celular da empresa
-- ------------------------------------------------------------
-- Recebe o id (do WhatsApp) da mensagem do cliente que foi lida e
-- deixa como não lidas só as mensagens do cliente que chegaram depois
-- dela. Nunca aumenta o contador.
CREATE OR REPLACE FUNCTION public.apply_phone_read(
  p_external_message_id TEXT,
  p_provider TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_left INTEGER;
BEGIN
  FOR r IN
    SELECT m.conversation_id, MAX(m.created_at) AS read_at
      FROM messages m
     WHERE m.message_id = p_external_message_id
       AND m.provider = p_provider
       AND m.sender_type = 'customer'
     GROUP BY m.conversation_id
  LOOP
    SELECT COUNT(*) INTO v_left
      FROM messages m
     WHERE m.conversation_id = r.conversation_id
       AND m.sender_type = 'customer'
       AND m.created_at > r.read_at;

    UPDATE conversations
       SET unread_count = LEAST(COALESCE(unread_count, 0), v_left)
     WHERE id = r.conversation_id
       AND COALESCE(unread_count, 0) > v_left;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_phone_read(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_phone_read(TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_phone_read(TEXT, TEXT) TO service_role;


-- ------------------------------------------------------------
-- 056_sales_revenue_and_conversion.sql
-- ------------------------------------------------------------

-- ============================================================
-- 056 — Faturamento por período e conversão por vendedor
-- ============================================================
--
-- 1. `deals.closed_at`: quando a negociação foi marcada como ganha ou
--    perdida. Faturamento = soma das negociações GANHAS com `closed_at`
--    dentro do período. Mantido por gatilho, então vale para o quadro,
--    o formulário, automações e API. Se a negociação for reaberta, a
--    data é apagada; se for fechada de novo, conta a nova data.
--    Negociações já fechadas antes desta migração recebem a data da
--    última alteração (`updated_at`), que é a melhor estimativa.
--
-- 2. `sales_by_seller(de, até)`: por vendedor, no período —
--      leads     = conversas novas (sem grupos) que estão com ele
--      won/lost  = negociações ganhas / perdidas
--      revenue   = soma das ganhas
--    Roda com as permissões de quem chama: o vendedor só enxerga os
--    próprios números; admin e dono enxergam todos.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_closed_at
  ON deals (account_id, closed_at)
  WHERE status IN ('won', 'lost');

CREATE OR REPLACE FUNCTION public.track_deal_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('won', 'lost') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      -- Acabou de ser fechada (ou trocou de ganha para perdida).
      NEW.closed_at := NOW();
    ELSE
      -- Continua fechada: mantém a data (editar o valor não muda o mês).
      NEW.closed_at := COALESCE(NEW.closed_at, OLD.closed_at, NOW());
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_deal_closed_at ON deals;
CREATE TRIGGER trg_track_deal_closed_at
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION public.track_deal_closed_at();

-- Negociações que já estavam fechadas.
UPDATE deals
   SET closed_at = COALESCE(updated_at, created_at, NOW())
 WHERE status IN ('won', 'lost')
   AND closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_created
  ON conversations (account_id, created_at);

-- ------------------------------------------------------------
-- Números por vendedor no período [p_from, p_to)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_by_seller(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
) RETURNS TABLE (
  user_id UUID,
  profile_id UUID,
  full_name TEXT,
  leads BIGINT,
  won BIGINT,
  lost BIGINT,
  revenue NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid()
  ),
  members AS (
    SELECT p.id AS profile_id, p.user_id, p.full_name
      FROM profiles p
      JOIN me ON p.account_id = me.account_id
  ),
  d AS (
    SELECT dl.assigned_to,
           COUNT(*) FILTER (WHERE dl.status = 'won')  AS won,
           COUNT(*) FILTER (WHERE dl.status = 'lost') AS lost,
           COALESCE(SUM(dl.value) FILTER (WHERE dl.status = 'won'), 0) AS revenue
      FROM deals dl
      JOIN me ON dl.account_id = me.account_id
     WHERE dl.status IN ('won', 'lost')
       AND dl.closed_at >= p_from
       AND dl.closed_at <  p_to
     GROUP BY dl.assigned_to
  ),
  l AS (
    SELECT c.assigned_agent_id, COUNT(*) AS leads
      FROM conversations c
      JOIN me ON c.account_id = me.account_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.created_at >= p_from
       AND c.created_at <  p_to
       AND COALESCE(ct.is_group, FALSE) = FALSE
     GROUP BY c.assigned_agent_id
  )
  SELECT m.user_id, m.profile_id, m.full_name,
         COALESCE(l.leads, 0), COALESCE(d.won, 0), COALESCE(d.lost, 0),
         COALESCE(d.revenue, 0)
    FROM members m
    LEFT JOIN d ON d.assigned_to = m.profile_id
    LEFT JOIN l ON l.assigned_agent_id = m.user_id
  UNION ALL
  -- Sem responsável (só aparece para quem enxerga tudo).
  SELECT NULL, NULL, NULL,
         COALESCE((SELECT leads FROM l WHERE assigned_agent_id IS NULL), 0),
         COALESCE((SELECT won FROM d WHERE assigned_to IS NULL), 0),
         COALESCE((SELECT lost FROM d WHERE assigned_to IS NULL), 0),
         COALESCE((SELECT revenue FROM d WHERE assigned_to IS NULL), 0);
$$;

REVOKE ALL ON FUNCTION public.sales_by_seller(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sales_by_seller(TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated;


-- ------------------------------------------------------------
-- 057_revenue_by_period.sql
-- ------------------------------------------------------------

-- ============================================================
-- 057 — Faturamento por dia, semana ou mês em qualquer período
-- ============================================================
--
-- 1. `revenue_by_period(de, até, agrupamento, fuso, funil)`
--    Soma das negociações GANHAS com `closed_at` (migração 056) no
--    período, separada por dia, semana (começa na segunda) ou mês, no
--    fuso de quem está olhando. `funil` é opcional: sem ele, conta
--    todos os funis.
--    Roda com as permissões de quem chama: o vendedor só soma as
--    negociações dele; admin e dono somam todas.
--
-- 2. Arrastar o card para a etapa "Ganho" conta como venda
--    Até aqui, só o botão "Marcar como ganho" mudava o status. Agora,
--    ao entrar numa etapa cujo nome começa com Ganho/Ganha/Won/Vendido,
--    a negociação vira GANHA; numa etapa Perdido/Perdida/Lost, vira
--    PERDIDA. Ao sair de uma dessas etapas para uma etapa comum, volta
--    a ficar aberta. Só reage a mudança de etapa: os botões
--    Ganho/Perdido/Reabrir continuam funcionando como antes.
--
-- Requer a 056. Pode ser executada mais de uma vez sem problema.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Faturamento por período
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revenue_by_period(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_tz TEXT DEFAULT 'America/Sao_Paulo',
  p_pipeline_id UUID DEFAULT NULL
) RETURNS TABLE (
  bucket DATE,
  won BIGINT,
  revenue NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cfg AS (
    SELECT
      CASE WHEN p_bucket IN ('day', 'week', 'month') THEN p_bucket ELSE 'day' END AS unit,
      COALESCE(
        (SELECT name FROM pg_timezone_names WHERE name = p_tz LIMIT 1),
        'America/Sao_Paulo'
      ) AS tz
  )
  SELECT date_trunc(cfg.unit, d.closed_at AT TIME ZONE cfg.tz)::date AS bucket,
         COUNT(*) AS won,
         COALESCE(SUM(d.value), 0) AS revenue
    FROM deals d
   CROSS JOIN cfg
   WHERE d.status = 'won'
     AND d.closed_at >= p_from
     AND d.closed_at <  p_to
     AND (p_pipeline_id IS NULL OR d.pipeline_id = p_pipeline_id)
   GROUP BY 1
   ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.revenue_by_period(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revenue_by_period(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID)
  TO authenticated;

-- ------------------------------------------------------------
-- 2. Etapa Ganho / Perdido muda o status
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deal_stage_outcome(p_stage_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN s.name ~* '^\s*(ganh|won|vendid)' THEN 'won'
           WHEN s.name ~* '^\s*(perd|lost)'       THEN 'lost'
           ELSE NULL
         END
    FROM pipeline_stages s
   WHERE s.id = p_stage_id;
$$;

CREATE OR REPLACE FUNCTION public.sync_deal_status_from_stage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_new TEXT;
  v_old TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;

  v_new := deal_stage_outcome(NEW.stage_id);

  IF v_new IS NOT NULL THEN
    NEW.status := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := deal_stage_outcome(OLD.stage_id);
    -- Saiu de Ganho/Perdido para uma etapa comum: volta a ficar aberta.
    IF v_old IS NOT NULL AND NEW.status = v_old THEN
      NEW.status := 'open';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- O nome faz este gatilho rodar ANTES do que grava `closed_at` (056):
-- o PostgreSQL executa gatilhos BEFORE em ordem alfabética.
DROP TRIGGER IF EXISTS trg_sync_deal_status_from_stage ON deals;
CREATE TRIGGER trg_sync_deal_status_from_stage
  BEFORE INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION public.sync_deal_status_from_stage();

-- ------------------------------------------------------------
-- 3. Uma vez agora: cards que já estão em Ganho/Perdido
-- ------------------------------------------------------------
-- Negociações abertas paradas numa etapa Ganho/Perdido passam a ganha/
-- perdida, com a data da última alteração delas (não a de hoje), para
-- caírem no mês certo do faturamento.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT d.id,
           deal_stage_outcome(d.stage_id) AS outcome,
           COALESCE(d.updated_at, d.created_at, NOW()) AS at
      FROM deals d
     WHERE d.status = 'open'
       AND deal_stage_outcome(d.stage_id) IS NOT NULL
  LOOP
    UPDATE deals SET status = r.outcome WHERE id = r.id;
    -- Mesmo status agora: o gatilho da 056 mantém a data informada aqui.
    UPDATE deals SET closed_at = r.at WHERE id = r.id;
  END LOOP;
END;
$$;


-- ------------------------------------------------------------
-- 058_monthly_payment_reminders.sql
-- ------------------------------------------------------------

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
