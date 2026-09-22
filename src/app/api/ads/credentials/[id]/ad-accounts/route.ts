import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadAdPlatformCredential,
  loadCredentialToken,
  recordCredentialVerification,
} from '@/lib/ads/credentials'
import { createMetaAdsClient } from '@/lib/ads/meta-ads-client'
import { MetaAdsClientError } from '@/lib/ads/meta-ads-errors'

/**
 * As contas de anúncio que o token deste portfólio enxerga.
 *
 * A tela usa isto para oferecer uma lista em vez de pedir que a pessoa
 * copie o identificador de cada conta na mão — com oito contas
 * espalhadas em dois portfólios, digitar id é convite a erro de
 * digitação que só apareceria na primeira verificação.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()

    // O filtro por conta acontece aqui: o id do portfólio vem da URL e
    // sozinho não prova posse, e o que vem depois é um token.
    const credential = await loadAdPlatformCredential(db, accountId, id)
    if (!credential) {
      return NextResponse.json(
        { error: 'Portfólio não encontrado' },
        { status: 404 },
      )
    }

    const accessToken = await loadCredentialToken(db, id)
    if (accessToken === null) {
      return NextResponse.json(
        { error: 'Este portfólio está sem token. Cole o token de novo.' },
        { status: 409 },
      )
    }

    const adAccounts = await createMetaAdsClient({
      accessToken,
    }).listAdAccounts(200)

    await recordCredentialVerification(db, id, { ok: true })
    return NextResponse.json({ ad_accounts: adAccounts })
  } catch (error) {
    if (error instanceof MetaAdsClientError) {
      return NextResponse.json({ error: error.humanMessage }, { status: 502 })
    }
    return toErrorResponse(error)
  }
}
