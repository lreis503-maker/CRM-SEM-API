import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  deleteAdPlatformCredential,
  listAdPlatformCredentials,
  loadAdPlatformCredential,
  recordCredentialVerification,
  saveAdPlatformCredential,
} from '@/lib/ads/credentials'
import { parseInternalPhone } from '@/lib/ads/internal-phone'
import { createMetaAdsClient } from '@/lib/ads/meta-ads-client'
import { MetaAdsClientError } from '@/lib/ads/meta-ads-errors'

/** Edita um portfólio: nome, número interno, ou troca de token. */
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

  const existing = await loadAdPlatformCredential(db, ctx.accountId, id)
  if (!existing) {
    return NextResponse.json(
      { error: 'Portfólio não encontrado' },
      { status: 404 },
    )
  }

  let label: string | undefined
  if (body.label !== undefined) {
    label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!label) {
      return NextResponse.json(
        { error: 'O nome do portfólio não pode ficar vazio.' },
        { status: 400 },
      )
    }
  }

  let internalNotifyPhone: string | null | undefined
  if (body.internal_notify_phone !== undefined) {
    const parsed = parseInternalPhone(body.internal_notify_phone)
    if (parsed === 'invalid') {
      return NextResponse.json(
        {
          error:
            'O número interno deve estar no formato internacional, por exemplo +5511999999999',
        },
        { status: 400 },
      )
    }
    internalNotifyPhone = parsed
  }

  const accessToken =
    typeof body.access_token === 'string' ? body.access_token.trim() : ''

  // Trocar o token revalida antes de gravar, mesma regra da criação:
  // um token quebrado guardado silenciosamente derruba o ciclo inteiro
  // deste portfólio sem ninguém entender por quê.
  if (accessToken) {
    try {
      await createMetaAdsClient({ accessToken }).listAdAccounts(1)
    } catch (error) {
      const message =
        error instanceof MetaAdsClientError
          ? error.humanMessage
          : 'Não foi possível validar o token com a Meta.'
      return NextResponse.json({ error: message }, { status: 400 })
    }
  }

  try {
    await saveAdPlatformCredential(db, {
      accountId: ctx.accountId,
      credentialId: id,
      label,
      accessToken: accessToken || undefined,
      internalNotifyPhone,
    })
    if (accessToken) {
      await recordCredentialVerification(db, id, { ok: true })
    }

    const credentials = await listAdPlatformCredentials(db, ctx.accountId)
    return NextResponse.json({ credentials })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'Já existe um portfólio com esse nome.' },
        { status: 409 },
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
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

  const db = supabaseAdmin()

  try {
    const result = await deleteAdPlatformCredential(db, ctx.accountId, id)
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 409 })
    }

    const credentials = await listAdPlatformCredentials(db, ctx.accountId)
    return NextResponse.json({ credentials })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
