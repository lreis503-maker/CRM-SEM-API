import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAdAccountMonitors } from '@/lib/ads/monitor-runner'

/**
 * Verifica as contas de anúncio monitoradas e dispara os avisos.
 *
 * Feita para ser chamada por um agendador externo (cron do Railway,
 * Vercel Cron, ou um pinger qualquer). A autenticação é o mesmo
 * segredo compartilhado usado por `/api/automations/cron`, só que com
 * a sua própria variável: quem tem o segredo do agendador de anúncios
 * não deveria conseguir drenar a fila de automações.
 *
 * Intervalo recomendado: a cada 15 minutos. `minIntervalMinutes`
 * protege a cota da Meta caso o agendador esteja mais apertado que
 * isso.
 */
export async function GET(request: Request) {
  const expected = process.env.ADS_MONITOR_CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'O monitoramento de contas de anúncio não está configurado' },
      { status: 503 },
    )
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const url = new URL(request.url)
  const limit = clampInteger(url.searchParams.get('limit'), 100, 1, 500)
  const minIntervalMinutes = clampInteger(
    url.searchParams.get('min_interval_minutes'),
    10,
    0,
    1440,
  )

  try {
    const result = await runAdAccountMonitors(
      supabaseAdmin(),
      { limit, minIntervalMinutes },
    )
    return NextResponse.json(result)
  } catch (error) {
    // O ciclo já trata falha por monitor; chegar aqui significa que a
    // própria leitura da lista quebrou, e aí não há o que salvar.
    const message = error instanceof Error ? error.message : String(error)
    console.error('[ads-monitor-cron] falha no ciclo:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function clampInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}
