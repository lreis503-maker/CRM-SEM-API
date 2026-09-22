-- ============================================================
-- 049_ad_account_funding_display
--
-- Correção da leitura de saldo.
--
-- A 047 tratava o campo `balance` da Meta como saldo restante. Ele é a
-- FATURA EM ABERTO: cresce conforme a conta gasta, em vez de diminuir.
-- Na prática o alerta estava invertido — disparava quando o cliente
-- tinha gasto pouco e silenciava conforme ele gastava.
--
-- O saldo de verdade vem de `funding_source_details.display_string`,
-- o mesmo texto que o Gerenciador de Anúncios mostra
-- ("Saldo disponível (R$278,60 BRL)"). Esta migração guarda esse texto
-- para diagnóstico e corrige os comentários das colunas.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

ALTER TABLE ad_account_monitor_state
  ADD COLUMN IF NOT EXISTS funding_source_display TEXT;

COMMENT ON COLUMN ad_account_monitor_state.funding_source_display IS
  'Texto cru da forma de pagamento na Meta. Guardado para conferir de onde saiu available_cents quando o número parecer errado.';

COMMENT ON COLUMN ad_account_monitor_state.balance_cents IS
  'Campo `balance` da Meta: FATURA EM ABERTO, não saldo. Cresce conforme a conta gasta. O saldo comparado com o limite é available_cents.';

COMMENT ON COLUMN ad_account_monitor_state.available_cents IS
  'O saldo que a regra comparou com o limite. Vem de funding_source_details.display_string quando a Meta informa, ou de spend_cap - amount_spent como rede. NULL quando não há saldo a comparar.';

-- As leituras antigas foram feitas com a regra invertida, então os
-- números gravados descrevem a fatura, não o saldo. Zerar o estado do
-- alerta faz a próxima verificação tratar cada conta como nova: se
-- houver saldo baixo de verdade, o aviso sai; se não, nada sai. Sem
-- isso, uma conta marcada como "em alerta" pela regra velha mandaria
-- um "saldo normalizado" que nunca foi verdade.
UPDATE ad_account_monitor_state
   SET low_balance_active = FALSE,
       low_balance_alert_at = NULL,
       available_cents = NULL,
       checked_at = NULL
 WHERE low_balance_active OR available_cents IS NOT NULL;
