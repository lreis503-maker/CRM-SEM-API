import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  listAdPlatformCredentials,
  recordCredentialVerification,
  saveAdPlatformCredential,
} from '@/lib/ads/credentials'
import { parseInternalPhone } from '@/lib/ads/internal-phone'
import { createMetaAdsClient } from '@/lib/ads/meta-ads-client'
import { MetaAdsClientError } from '@/lib/ads/meta-ads-errors'

/**
 * Portfólios empresariais conectados.
 *
 * O GET devolve só metadados — nunca o token, nem mascarado. Um token
 * mascarado ainda é informação sobre um segredo e não serve para nada
 * na tela: `last_verified_at` já responde "está funcionando?".
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const credentials = await listAdPlatformCredentials(
      supabaseAdmin(),
      accountId,
    )
    return NextResponse.json({ credentials })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Conecta um portfólio novo. */
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

  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) {
    return NextResponse.json(
      { error: 'Dê um nome ao portfólio para distinguir um do outro.' },
      { status: 400 },
    )
  }

  const accessToken =
    typeof body.access_token === 'string' ? body.access_token.trim() : ''
  if (!accessToken) {
    return NextResponse.json(
      { error: 'Cole o token de usuário de sistema deste portfólio.' },
      { status: 400 },
    )
  }

  const phone = parseInternalPhone(body.internal_notify_phone)
  if (phone === 'invalid') {
    return NextResponse.json(
      {
        error:
          'O número interno deve estar no formato internacional, por exemplo +5511999999999',
      },
      { status: 400 },
    )
  }

  // Um token só é gravado depois de provar que funciona. Gravar
  // primeiro e validar depois deixaria a conta num estado em que o
  // ciclo roda, falha em todo monitor e enche o WhatsApp da equipe.
  try {
    await createMetaAdsClient({ accessToken }).listAdAccounts(1)
  } catch (error) {
    const message =
      error instanceof MetaAdsClientError
        ? error.humanMessage
        : 'Não foi possível validar o token com a Meta.'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const db = supabaseAdmin()

  try {
    const credential = await saveAdPlatformCredential(db, {
      accountId: ctx.accountId,
      label,
      accessToken,
      businessId:
        typeof body.business_id === 'string' ? body.business_id.trim() : null,
      internalNotifyPhone: phone,
    })
    await recordCredentialVerification(db, credential.id, { ok: true })

    const credentials = await listAdPlatformCredentials(db, ctx.accountId)
    return NextResponse.json({ credentials }, { status: 201 })
  } catch (error) {
    // 23505 = já existe um portfólio com esse nome nesta conta.
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
