import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { normalizeAdAccountId } from '@/lib/ads/meta-ads-client'

/**
 * Contas de anúncio monitoradas.
 *
 * GET lista, com o último retrato junto. POST cadastra.
 * Mesma divisão das outras rotas do CRM: leitura pelo cliente do
 * usuário (a RLS faz o escopo) e escrita pelo service role depois de
 * um teste explícito de papel.
 */
export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()

    const { data: monitors, error } = await supabase
      .from('ad_account_monitors')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows = monitors ?? []
    if (rows.length === 0) return NextResponse.json({ monitors: [] })

    const { data: states } = await supabase
      .from('ad_account_monitor_state')
      .select('*')
      .in(
        'monitor_id',
        rows.map((row) => row.id as string),
      )

    const byMonitor = new Map<string, unknown>()
    for (const state of states ?? []) {
      byMonitor.set(String(state.monitor_id), state)
    }

    return NextResponse.json({
      monitors: rows.map((row) => ({
        ...row,
        state: byMonitor.get(String(row.id)) ?? null,
      })),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const externalAccountId = normalizeAdAccountId(body.external_account_id)
  if (externalAccountId === null) {
    return NextResponse.json(
      {
        error:
          'Informe o identificador da conta de anúncio, com ou sem o prefixo act_ (ex.: act_1234567890).',
      },
      { status: 400 },
    )
  }

  const thresholdCents = parseThreshold(body.low_balance_threshold_cents)
  if (thresholdCents === null) {
    return NextResponse.json(
      { error: 'O limite de saldo deve ser um valor em centavos, maior ou igual a zero.' },
      { status: 400 },
    )
  }

  const credentialId =
    typeof body.credential_id === 'string' && body.credential_id.length > 0
      ? body.credential_id
      : null
  if (credentialId === null) {
    return NextResponse.json(
      { error: 'Escolha de qual portfólio esta conta de anúncio vem.' },
      { status: 400 },
    )
  }

  const contactId =
    typeof body.contact_id === 'string' && body.contact_id.length > 0
      ? body.contact_id
      : null

  const db = supabaseAdmin()

  // O portfólio tem que ser desta conta do CRM. Sem esta checagem, um
  // id de credencial de outro locatário ligaria o monitor ao token
  // alheio — e é o token que decide quais contas de anúncio são lidas.
  const { data: credential } = await db
    .from('ad_platform_credentials')
    .select('id')
    .eq('id', credentialId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!credential) {
    return NextResponse.json(
      { error: 'O portfólio informado não existe nesta conta.' },
      { status: 400 },
    )
  }

  // O contato tem que ser desta conta do CRM. A rota grava com service
  // role, que ignora RLS, então a checagem de posse é feita aqui — a
  // mesma defesa que o envio das automações faz antes de disparar.
  if (contactId !== null) {
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json(
        { error: 'O contato informado não existe nesta conta.' },
        { status: 400 },
      )
    }
  }

  const { data, error } = await db
    .from('ad_account_monitors')
    .insert({
      account_id: ctx.accountId,
      platform: 'meta',
      credential_id: credentialId,
      external_account_id: externalAccountId,
      display_name:
        typeof body.display_name === 'string' && body.display_name.trim()
          ? body.display_name.trim()
          : null,
      contact_id: contactId,
      low_balance_threshold_cents: thresholdCents,
      notify_client: body.notify_client !== false,
      notify_internal: body.notify_internal !== false,
      cooldown_hours: parseCooldown(body.cooldown_hours),
      created_by: ctx.userId,
    })
    .select()
    .single()

  if (error) {
    // 23505 = a mesma conta de anúncio já está cadastrada.
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'Esta conta de anúncio já está sendo monitorada.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ monitor: data }, { status: 201 })
}

function parseThreshold(value: unknown): number | null {
  if (value === undefined || value === null) return 10000
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.trunc(parsed)
}

function parseCooldown(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 24
  return Math.min(Math.max(Math.trunc(parsed), 0), 720)
}
