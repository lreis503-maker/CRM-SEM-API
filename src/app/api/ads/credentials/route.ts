import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadAdPlatformCredential,
  loadAdPlatformCredentialWithToken,
  recordCredentialVerification,
  saveAdPlatformCredential,
} from '@/lib/ads/credentials'
import { createMetaAdsClient } from '@/lib/ads/meta-ads-client'
import { MetaAdsClientError } from '@/lib/ads/meta-ads-errors'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * Token de usuário de sistema do Business Manager e número interno de
 * cópia.
 *
 * O GET devolve só metadados — nunca o token, nem mascarado. Um token
 * mascarado ainda é informação sobre um segredo e não serve para nada
 * na tela: `last_verified_at` já responde "está funcionando?".
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const credential = await loadAdPlatformCredential(supabaseAdmin(), accountId)
    return NextResponse.json({
      credential,
      configured: credential !== null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PUT(request: Request) {
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

  const accessToken =
    typeof body.access_token === 'string' ? body.access_token.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() : null
  const businessId =
    typeof body.business_id === 'string' ? body.business_id.trim() : null

  let internalNotifyPhone: string | null | undefined
  if (body.internal_notify_phone === null || body.internal_notify_phone === '') {
    internalNotifyPhone = null
  } else if (typeof body.internal_notify_phone === 'string') {
    const sanitized = sanitizePhoneForMeta(body.internal_notify_phone)
    if (!isValidE164(sanitized)) {
      return NextResponse.json(
        {
          error:
            'O número interno deve estar no formato internacional, por exemplo +5511999999999',
        },
        { status: 400 },
      )
    }
    internalNotifyPhone = sanitized
  }

  const db = supabaseAdmin()

  // Um token só é gravado depois de provar que funciona. Gravar
  // primeiro e validar depois deixaria a conta num estado em que o
  // ciclo roda, falha em todo monitor e enche o WhatsApp da equipe.
  if (accessToken.length > 0) {
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
    const credential = await saveAdPlatformCredential(db, {
      accountId: ctx.accountId,
      accessToken: accessToken.length > 0 ? accessToken : undefined,
      label,
      businessId,
      internalNotifyPhone,
    })

    if (accessToken.length > 0) {
      await recordCredentialVerification(db, credential.id, { ok: true })
    }

    const saved = await loadAdPlatformCredential(db, ctx.accountId)
    return NextResponse.json({ credential: saved, configured: saved !== null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Contas de anúncio que o token enxerga, para a tela oferecer uma
 * lista em vez de pedir que a pessoa cole o id na mão.
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()
    const credential = await loadAdPlatformCredentialWithToken(db, accountId)
    if (credential === null) {
      return NextResponse.json(
        { error: 'Configure o token do Business Manager primeiro.' },
        { status: 409 },
      )
    }

    const accounts = await createMetaAdsClient({
      accessToken: credential.accessToken,
    }).listAdAccounts(200)

    await recordCredentialVerification(db, credential.id, { ok: true })
    return NextResponse.json({ ad_accounts: accounts })
  } catch (error) {
    if (error instanceof MetaAdsClientError) {
      return NextResponse.json({ error: error.humanMessage }, { status: 502 })
    }
    return toErrorResponse(error)
  }
}
