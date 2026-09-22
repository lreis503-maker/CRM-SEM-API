import { afterEach, describe, expect, it, vi } from 'vitest'

const runAdAccountMonitors = vi.fn()

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ marker: 'admin-client' }),
}))
vi.mock('@/lib/ads/monitor-runner', () => ({
  runAdAccountMonitors: (...args: unknown[]) => runAdAccountMonitors(...args),
}))

import { GET } from './route'

function request(headers: Record<string, string> = {}, query = ''): Request {
  return new Request(`https://crm.example/api/ads/monitor/cron${query}`, {
    headers,
  })
}

const SECRET = 'segredo-do-agendador-de-anuncios'

afterEach(() => {
  delete process.env.ADS_MONITOR_CRON_SECRET
  runAdAccountMonitors.mockReset()
})

describe('GET /api/ads/monitor/cron', () => {
  it('responde 503 quando o segredo não foi configurado', async () => {
    const response = await GET(request({ 'x-cron-secret': SECRET }))
    expect(response.status).toBe(503)
    expect(runAdAccountMonitors).not.toHaveBeenCalled()
  })

  it('recusa quem não manda o segredo', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    const response = await GET(request())
    expect(response.status).toBe(401)
    expect(runAdAccountMonitors).not.toHaveBeenCalled()
  })

  it('recusa um segredo errado do mesmo tamanho', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    const wrong = 'x'.repeat(SECRET.length)
    const response = await GET(request({ 'x-cron-secret': wrong }))
    expect(response.status).toBe(401)
  })

  it('recusa um segredo de outro tamanho sem estourar na comparação', async () => {
    // timingSafeEqual lança quando os buffers têm tamanhos diferentes;
    // a rota compara o comprimento antes por causa disso.
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    const response = await GET(request({ 'x-cron-secret': 'curto' }))
    expect(response.status).toBe(401)
  })

  it('roda o ciclo e devolve o resumo', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    runAdAccountMonitors.mockResolvedValue({
      checked: 3,
      skipped: 1,
      alerts: 2,
      failures: 0,
    })

    const response = await GET(request({ 'x-cron-secret': SECRET }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      checked: 3,
      skipped: 1,
      alerts: 2,
      failures: 0,
    })
    expect(runAdAccountMonitors).toHaveBeenCalledWith(
      { marker: 'admin-client' },
      { limit: 100, minIntervalMinutes: 10 },
    )
  })

  it('aceita limite e intervalo pela query, dentro dos extremos', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    runAdAccountMonitors.mockResolvedValue({})

    await GET(
      request(
        { 'x-cron-secret': SECRET },
        '?limit=9999&min_interval_minutes=-5',
      ),
    )

    expect(runAdAccountMonitors).toHaveBeenCalledWith(expect.anything(), {
      limit: 500,
      minIntervalMinutes: 0,
    })
  })

  it('ignora valores não numéricos e usa os padrões', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    runAdAccountMonitors.mockResolvedValue({})

    await GET(request({ 'x-cron-secret': SECRET }, '?limit=todos'))

    expect(runAdAccountMonitors).toHaveBeenCalledWith(expect.anything(), {
      limit: 100,
      minIntervalMinutes: 10,
    })
  })

  it('devolve 500 quando o ciclo inteiro quebra', async () => {
    process.env.ADS_MONITOR_CRON_SECRET = SECRET
    runAdAccountMonitors.mockRejectedValue(new Error('banco fora do ar'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await GET(request({ 'x-cron-secret': SECRET }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'banco fora do ar' })
    errorSpy.mockRestore()
  })
})
