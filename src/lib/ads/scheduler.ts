/**
 * O agendador que roda dentro do próprio CRM.
 *
 * Antes disso o monitor dependia de alguém chamar
 * `/api/ads/monitor/cron` de fora. A rota continua existindo e
 * funcionando — é o caminho certo para quem roda várias instâncias ou
 * prefere um agendador de verdade —, mas numa instalação comum o CRM
 * agora se vira sozinho.
 *
 * Duas proteções contra mandar a mesma mensagem duas vezes:
 *
 * 1. **A trava no banco.** Duas instâncias acordam na mesma hora; só
 *    uma consegue o UPDATE condicional da linha de trava e roda. É uma
 *    concessão de prazo, não um "liberar no fim": se a instância morrer
 *    no meio do ciclo, a trava se solta sozinha.
 * 2. **O intervalo mínimo por conta.** Mesmo que duas rodadas se
 *    sobreponham, uma conta verificada há menos de 55 minutos é pulada.
 *
 * Nada disso substitui o intervalo entre avisos (`cooldown_hours`), que
 * é quem decide se um problema que continua gera mensagem nova.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { runAdAccountMonitors } from './monitor-runner';

/** De hora em hora, como pedido. */
const TICK_INTERVAL_MS = 60 * 60_000;

/**
 * Espera antes do primeiro ciclo. O processo acabou de subir e ainda
 * está atendendo as primeiras requisições; ler oito contas na Meta
 * pode esperar um minuto.
 */
const FIRST_TICK_DELAY_MS = 60_000;

/**
 * Validade da trava. Generosa o bastante para um ciclo inteiro caber,
 * curta o bastante para uma instância morta não travar o monitor até
 * o próximo deploy.
 */
const LEASE_MS = 20 * 60_000;

/**
 * Não relê uma conta verificada há menos que isto. Fica abaixo da hora
 * de propósito: um ciclo que atrase alguns minutos não deve pular a
 * volta inteira.
 */
const MIN_INTERVAL_MINUTES = 55;

let started = false;

function schedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  // Desligar é explícito. Quem quiser usar só o agendador externo
  // define ADS_MONITOR_AUTORUN=false.
  if (env.ADS_MONITOR_AUTORUN === 'false') return false;

  // Sem credencial de service role não há como ler nada; melhor não
  // subir um laço que só vai falhar de hora em hora.
  return Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Tenta pegar a trava. Devolve `true` para quem vai rodar o ciclo.
 *
 * O filtro `locked_until < agora` viaja junto do UPDATE, então quem
 * perde a disputa não recebe linha nenhuma de volta. Duas instâncias
 * não têm como sair as duas com `true`.
 */
export async function acquireSchedulerLease(
  db: SupabaseClient,
  holder: string,
  now: Date = new Date(),
  leaseMs: number = LEASE_MS
): Promise<boolean> {
  const { data, error } = await db
    .from('ad_monitor_scheduler_lease')
    .update({
      locked_until: new Date(now.getTime() + leaseMs).toISOString(),
      holder,
      updated_at: now.toISOString(),
    })
    .eq('id', true)
    .lt('locked_until', now.toISOString())
    .select('id');

  if (error) throw error;
  return (data ?? []).length > 0;
}

async function tick(holder: string): Promise<void> {
  const db = supabaseAdmin();

  if (!(await acquireSchedulerLease(db, holder))) return;

  await runAdAccountMonitors(db, {
    limit: 500,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
  });
}

/**
 * Liga o laço. Chamada uma vez, pelo `register()` do Next.
 *
 * Erros de um ciclo são registrados e engolidos: uma falha de rede na
 * Meta às 3h da manhã não pode derrubar o laço e deixar o monitor
 * parado até alguém reiniciar o servidor.
 */
export function startAdMonitorScheduler(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (started) return false;
  if (!schedulerEnabled(env)) return false;

  started = true;

  const holder = `${process.pid}@${new Date().toISOString()}`;

  const run = () => {
    void tick(holder).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ads-monitor-scheduler] ciclo falhou:', message);
    });
  };

  // `unref` para o laço não segurar o processo vivo sozinho. Num
  // servidor isso não muda nada; num script que importe este módulo,
  // evita um processo que nunca termina.
  setTimeout(run, FIRST_TICK_DELAY_MS).unref?.();
  setInterval(run, TICK_INTERVAL_MS).unref?.();

  return true;
}

/** Só para teste: desfaz a trava de "uma vez por processo". */
export function resetSchedulerForTests(): void {
  started = false;
}
