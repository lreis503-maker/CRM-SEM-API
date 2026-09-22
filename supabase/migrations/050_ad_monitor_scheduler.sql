-- ============================================================
-- 050_ad_monitor_scheduler
--
-- Duas mudanças pedidas depois da primeira semana de uso:
--
--   1. o próprio CRM passa a verificar as contas de hora em hora, sem
--      depender de um agendador externo;
--   2. o aviso de saldo baixo sai UMA VEZ por evento, e não a cada
--      ciclo — verificar de hora em hora não pode virar uma mensagem
--      por hora no WhatsApp do cliente.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- 1. Trava do agendador
--
-- O agendador roda dentro do processo do CRM. Se o Railway subir duas
-- instâncias, as duas acordam na mesma hora e verificariam as mesmas
-- contas — e o cliente receberia a mensagem duas vezes.
--
-- Uma linha só, com prazo de validade. Quem consegue o UPDATE
-- condicional roda o ciclo; quem não consegue volta a dormir. O UPDATE
-- é atômico no Postgres, então não existe empate.
--
-- Prazo em vez de "liberar no fim": se a instância que pegou a trava
-- morrer no meio do ciclo, a trava se solta sozinha em vez de travar o
-- monitoramento para sempre.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_monitor_scheduler_lease (
  -- Chave booleana com CHECK: garante fisicamente uma linha só.
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  locked_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  /** Identifica a instância que segurou a trava por último. Diagnóstico. */
  holder TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ad_monitor_scheduler_lease (id, locked_until)
VALUES (TRUE, NOW())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE ad_monitor_scheduler_lease ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ad_monitor_scheduler_lease IS
  'Trava de instância única do agendador do monitor de anúncios. Sem policies: só o service role alcança.';

-- ============================================================
-- 2. Um aviso por evento
--
-- `cooldown_hours = 0` significa "avise só na transição": o aviso sai
-- quando o saldo cruza para baixo do limite e não se repete enquanto
-- continuar lá. Um novo aviso só acontece depois de o saldo se
-- recuperar (e cruzar para baixo de novo).
-- ============================================================
ALTER TABLE ad_account_monitors
  ALTER COLUMN cooldown_hours SET DEFAULT 0;

UPDATE ad_account_monitors
   SET cooldown_hours = 0
 WHERE cooldown_hours <> 0;

COMMENT ON COLUMN ad_account_monitors.cooldown_hours IS
  'Intervalo mínimo entre avisos repetidos do mesmo problema. Zero (padrão) avisa só na transição — uma mensagem por evento.';
