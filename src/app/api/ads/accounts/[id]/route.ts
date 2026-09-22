import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/** Edita ou remove uma conta de anúncio monitorada. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

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

  const db = supabaseAdmin()
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.low_balance_threshold_cents !== undefined) {
    const parsed = Number(body.low_balance_threshold_cents)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return NextResponse.json(
        { error: 'O limite de saldo deve ser um valor em centavos, maior ou igual a zero.' },
        { status: 400 },
      )
    }
    patch.low_balance_threshold_cents = Math.trunc(parsed)
  }

  if (body.cooldown_hours !== undefined) {
    const parsed = Number(body.cooldown_hours)
    if (!Number.isFinite(parsed)) {
      return NextResponse.json(
        { error: 'O intervalo entre avisos deve ser um número de horas.' },
        { status: 400 },
      )
    }
    patch.cooldown_hours = Math.min(Math.max(Math.trunc(parsed), 0), 720)
  }

  if (body.credential_id !== undefined) {
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
    patch.credential_id = credentialId
  }

  if (body.contact_id !== undefined) {
    const contactId =
      typeof body.contact_id === 'string' && body.contact_id.length > 0
        ? body.contact_id
        : null
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
    patch.contact_id = contactId
  }

  if (body.enabled !== undefined) patch.enabled = body.enabled === true
  if (body.notify_client !== undefined) {
    patch.notify_client = body.notify_client === true
  }
  if (body.notify_internal !== undefined) {
    patch.notify_internal = body.notify_internal === true
  }

  // O filtro por account_id é o que impede editar o monitor de outra
  // conta com o service role: o id sozinho não prova posse.
  const { data, error } = await db
    .from('ad_account_monitors')
    .update(patch)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select()
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    return NextResponse.json({ error: 'Monitor não encontrado' }, { status: 404 })
  }
  return NextResponse.json({ monitor: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }

  const { error } = await supabaseAdmin()
    .from('ad_account_monitors')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
