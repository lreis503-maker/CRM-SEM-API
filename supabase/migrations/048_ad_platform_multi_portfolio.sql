-- ============================================================
-- 048_ad_platform_multi_portfolio
--
-- A 047 assumiu um portfólio empresarial por conta do CRM: uma
-- credencial, um token, e todo monitor lia por ela. Uma agência com
-- dois portfólios precisa de dois tokens, porque o usuário de sistema
-- de um portfólio não enxerga as contas de anúncio do outro.
--
-- Esta migração:
--   1. permite várias credenciais por conta do CRM, cada uma com um
--      rótulo que identifica o portfólio;
--   2. liga cada conta de anúncio monitorada à credencial do portfólio
--      a que ela pertence.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- 1. Uma credencial por portfólio, não por conta do CRM
-- ============================================================

-- O rótulo deixa de ser enfeite e passa a ser como a pessoa distingue
-- um portfólio do outro na tela. Linhas antigas ganham um nome antes
-- de a coluna virar obrigatória.
UPDATE ad_platform_credentials
   SET label = 'Portfólio principal'
 WHERE label IS NULL OR btrim(label) = '';

ALTER TABLE ad_platform_credentials
  ALTER COLUMN label SET NOT NULL;

-- A unicidade antiga (account_id, platform) é justamente o que
-- impedia o segundo portfólio.
ALTER TABLE ad_platform_credentials
  DROP CONSTRAINT IF EXISTS ad_platform_credentials_account_id_platform_key;

-- Dois portfólios com o mesmo nome na mesma conta do CRM só criariam
-- confusão na hora de escolher qual usar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_platform_credentials_account_label
  ON ad_platform_credentials(account_id, platform, lower(btrim(label)));

COMMENT ON COLUMN ad_platform_credentials.label IS
  'Nome do portfólio empresarial, como a equipe o reconhece. Único por conta.';

-- ============================================================
-- 2. Cada conta de anúncio sabe de qual portfólio ela vem
-- ============================================================
ALTER TABLE ad_account_monitors
  ADD COLUMN IF NOT EXISTS credential_id UUID
    REFERENCES ad_platform_credentials(id) ON DELETE RESTRICT;

COMMENT ON COLUMN ad_account_monitors.credential_id IS
  'Portfólio cujo token lê esta conta. RESTRICT: remover um portfólio com contas ligadas é recusado, em vez de apagá-las em silêncio.';

-- Backfill: quem já existia pertence ao único portfólio que a conta
-- tinha. O filtro de contagem evita atribuir errado numa conta que,
-- por algum motivo, já tivesse mais de uma credencial.
UPDATE ad_account_monitors AS m
   SET credential_id = c.id
  FROM ad_platform_credentials AS c
 WHERE m.credential_id IS NULL
   AND c.account_id = m.account_id
   AND c.platform = m.platform
   AND (
     SELECT count(*) FROM ad_platform_credentials AS c2
      WHERE c2.account_id = m.account_id AND c2.platform = m.platform
   ) = 1;

-- NOT NULL só quando o backfill cobriu tudo. Uma conta do CRM que
-- tenha monitores mas nenhuma credencial (credencial apagada à mão,
-- por exemplo) não deve derrubar a migração: o runner já trata
-- credential_id nulo pulando o monitor e gravando o motivo.
DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM ad_account_monitors WHERE credential_id IS NULL;

  IF v_orphans = 0 THEN
    BEGIN
      ALTER TABLE ad_account_monitors
        ALTER COLUMN credential_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'credential_id continua opcional: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE
      '% monitor(es) sem portfólio. Abra /ads-monitor e escolha o portfólio de cada conta.',
      v_orphans;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ad_account_monitors_credential
  ON ad_account_monitors(credential_id)
  WHERE enabled;
