-- ============================================================
-- 047_ad_account_monitor
--
-- Monitoramento das contas de anúncio dos clientes e aviso no
-- WhatsApp quando o saldo cai abaixo do limite ou quando a cobrança
-- para (cartão recusado, conta sem forma de pagamento, conta
-- desativada por pagamento).
--
-- O token de usuário de sistema do Business Manager é uma credencial
-- da conta do CRM, não do navegador: ele fica em
-- `ad_platform_credential_secrets`, uma tabela com RLS ligada e sem
-- nenhuma policy, exatamente como `whatsapp_config_secrets` na 043.
-- ============================================================

-- ============================================================
-- Credencial da plataforma de anúncios (uma por conta do CRM)
--
-- Esta linha é legível pelo navegador: ela guarda só metadados
-- (rótulo, id do Business Manager, quando foi validada pela última
-- vez). O token nunca passa por aqui.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_platform_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  -- Como o usuário reconhece esta credencial na tela.
  label TEXT,
  -- Business Manager dono do token, quando informado. Serve para
  -- diagnóstico: um token do BM errado não enxerga as contas.
  business_id TEXT,
  -- Resultado da última chamada de validação. `error` aqui é a
  -- mensagem que a tela mostra; nunca carrega o token.
  last_verified_at TIMESTAMPTZ,
  last_verify_error TEXT,
  -- Número interno que recebe a cópia de todo alerta, em E.164
  -- (ex.: +5511999999999). Fica aqui, e não numa variável de
  -- ambiente, porque cada conta do CRM tem a sua equipe.
  internal_notify_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Uma credencial por plataforma por conta. O token de sistema do BM
  -- da agência já enxerga todas as contas de cliente compartilhadas
  -- com ele, então não há motivo para permitir várias.
  UNIQUE (account_id, platform)
);

ALTER TABLE ad_platform_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_platform_credentials_select ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_insert ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_update ON ad_platform_credentials;
DROP POLICY IF EXISTS ad_platform_credentials_delete ON ad_platform_credentials;
CREATE POLICY ad_platform_credentials_select ON ad_platform_credentials
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ad_platform_credentials_insert ON ad_platform_credentials
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ad_platform_credentials_update ON ad_platform_credentials
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY ad_platform_credentials_delete ON ad_platform_credentials
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Token da plataforma — somente service role
--
-- Sem policies de propósito: o navegador não tem caminho até esta
-- tabela nem com RLS correta em outro lugar. O formato conferido é o
-- do AES-256-GCM de src/lib/whatsapp/encryption.ts: IV de 12 bytes,
-- ciphertext não vazio e tag de autenticação de 16 bytes.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_platform_credential_secrets (
  credential_id UUID PRIMARY KEY
    REFERENCES ad_platform_credentials(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  CONSTRAINT ad_platform_credential_secrets_access_token_encrypted_check
    CHECK (access_token ~ '^[0-9A-Fa-f]{24}:[0-9A-Fa-f]+:[0-9A-Fa-f]{32}$')
);

ALTER TABLE ad_platform_credential_secrets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ad_platform_credential_secrets IS
  'Token de usuário de sistema da plataforma de anúncios. Só o service role alcança.';
COMMENT ON COLUMN ad_platform_credential_secrets.access_token IS
  'Ciphertext AES-256-GCM do helper de criptografia do servidor; nunca texto claro.';

-- ============================================================
-- Contas de anúncio monitoradas
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_monitors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  -- Só os dígitos, sem o prefixo `act_`. A API recebe o prefixo; o
  -- banco guarda a forma canônica para a UNIQUE abaixo funcionar
  -- mesmo se a pessoa colar "act_123" numa vez e "123" na outra.
  external_account_id TEXT NOT NULL
    CHECK (external_account_id ~ '^[0-9]{1,32}$'),
  -- Nome que a Meta devolve, atualizado a cada leitura. Cai para o id
  -- quando a conta ainda não foi lida uma vez.
  display_name TEXT,
  -- Contato do CRM que recebe o aviso. ON DELETE SET NULL porque
  -- apagar o contato não deve apagar o histórico de alertas nem parar
  -- o monitoramento: a cópia interna continua saindo.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Limite de saldo baixo, na menor unidade da moeda da conta de
  -- anúncio (centavos). R$ 100,00 = 10000.
  low_balance_threshold_cents BIGINT NOT NULL DEFAULT 10000
    CHECK (low_balance_threshold_cents >= 0),
  -- Moeda lida da Meta, guardada para formatar a mensagem sem uma
  -- segunda chamada. Preenchida na primeira leitura.
  currency TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notify_client BOOLEAN NOT NULL DEFAULT TRUE,
  notify_internal BOOLEAN NOT NULL DEFAULT TRUE,
  -- Enquanto o problema continua, o aviso se repete no máximo uma vez
  -- por esse intervalo. Zero significa avisar só na transição.
  cooldown_hours INTEGER NOT NULL DEFAULT 24
    CHECK (cooldown_hours >= 0 AND cooldown_hours <= 720),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, platform, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_account
  ON ad_account_monitors(account_id)
  WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_contact
  ON ad_account_monitors(account_id, contact_id);

ALTER TABLE ad_account_monitors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_monitors_select ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_insert ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_update ON ad_account_monitors;
DROP POLICY IF EXISTS ad_account_monitors_delete ON ad_account_monitors;
CREATE POLICY ad_account_monitors_select ON ad_account_monitors
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ad_account_monitors_insert ON ad_account_monitors
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ad_account_monitors_update ON ad_account_monitors
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY ad_account_monitors_delete ON ad_account_monitors
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Última leitura e estado do alerta
--
-- Uma linha por monitor. É aqui que mora a decisão de não repetir o
-- mesmo aviso: `*_active` guarda se o problema já estava valendo na
-- leitura anterior e `*_alert_at` quando o último aviso saiu.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_monitor_state (
  monitor_id UUID PRIMARY KEY
    REFERENCES ad_account_monitors(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ,

  -- Campos crus da Meta, em centavos, exatamente como vieram. Guardados
  -- para o usuário conferir contra o Gerenciador de Anúncios sem
  -- precisar de outra chamada: a Meta não expõe um único campo
  -- "saldo restante" e o cálculo muda entre conta pré-paga e pós-paga.
  balance_cents BIGINT,
  amount_spent_cents BIGINT,
  spend_cap_cents BIGINT,
  -- O saldo que a regra de alerta realmente comparou, ou NULL quando a
  -- conta é pós-paga sem limite de gastos e não existe saldo a comparar.
  available_cents BIGINT,
  currency TEXT,
  is_prepay_account BOOLEAN,
  account_status INTEGER,
  disable_reason INTEGER,
  has_funding_source BOOLEAN,

  low_balance_active BOOLEAN NOT NULL DEFAULT FALSE,
  low_balance_alert_at TIMESTAMPTZ,
  payment_issue_active BOOLEAN NOT NULL DEFAULT FALSE,
  payment_issue_alert_at TIMESTAMPTZ,
  -- Código estável do problema de cobrança (ex.: 'unsettled',
  -- 'no_funding_source'). Trocar de código conta como problema novo.
  payment_issue_code TEXT,

  -- Leituras que falharam em sequência. Serve para não gritar a cada
  -- 15 minutos quando a Meta está fora do ar.
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ad_account_monitor_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_monitor_state_select ON ad_account_monitor_state;
CREATE POLICY ad_account_monitor_state_select ON ad_account_monitor_state
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita: só o runner, com service role, escreve aqui.

-- ============================================================
-- Histórico de avisos enviados
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_account_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  monitor_id UUID REFERENCES ad_account_monitors(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'low_balance',
    'payment_stopped',
    'balance_recovered',
    'payment_recovered',
    -- A leitura na Meta falhou de um jeito que precisa de ação
    -- humana (token expirado, acesso removido). Só cópia interna:
    -- não é problema do cliente.
    'read_failed'
  )),
  -- Motivo legível estável, ex.: 'unsettled', 'no_funding_source',
  -- 'disabled', 'below_threshold'.
  reason_code TEXT,
  -- O texto que saiu no WhatsApp, guardado como foi enviado.
  message TEXT NOT NULL,
  -- Números da leitura que gerou o aviso, para auditoria.
  snapshot JSONB,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- 'sent', 'partial' (uma das duas pontas falhou), 'failed', 'skipped'.
  delivery_status TEXT NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('sent', 'partial', 'failed', 'skipped')),
  client_error TEXT,
  internal_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_account_alerts_account_created
  ON ad_account_alerts(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_account_alerts_monitor_created
  ON ad_account_alerts(monitor_id, created_at DESC);

ALTER TABLE ad_account_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_account_alerts_select ON ad_account_alerts;
CREATE POLICY ad_account_alerts_select ON ad_account_alerts
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita: o histórico é escrito só pelo runner.
