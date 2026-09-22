import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAdAccountMonitors } from '@/lib/ads/monitor-runner'

/**
 * "Verificar agora" da tela.
 *
 * Roda o mesmo ciclo do cron, restrito à conta de quem clicou e sem
 * o intervalo mínimo — quem pediu a verificação quer o número de
 * agora. Os avisos saem de verdade: é o comportamento que faz o teste
 * valer alguma coisa, e o intervalo de espera continua impedindo que
 * clicar duas vezes mande duas mensagens iguais para o cliente.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }

  const body = await request.json().catch(() => null)
  const monitorId =
    body && typeof body.monitor_id === 'string' && body.monitor_id.length > 0
      ? body.monitor_id
      : undefined

  try {
    const result = await runAdAccountMonitors(supabaseAdmin(), {
      accountId: ctx.accountId,
      monitorId,
      minIntervalMinutes: 0,
      limit: 200,
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
