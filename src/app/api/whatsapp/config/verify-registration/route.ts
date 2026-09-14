import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { hasConfiguredMetaAppSecret } from '@/lib/whatsapp/webhook-signature'
import { appSubscriptionState } from '@/lib/whatsapp/waba-pairing'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: "Seu perfil não está vinculado a uma conta.",
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: "Nenhuma configuração do WhatsApp salva.",
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Não foi possível descriptografar o token salvo. ENCRYPTION_KEY pode ter mudado. Informe o token novamente para corrigir.",
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
    webhook_secret_configured: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
    webhook_secret_configured: hasConfiguredMetaAppSecret(),
  }
  const errors: string[] = []
  if (!checks.webhook_secret_configured) {
    errors.push(
      'Configure META_APP_SECRET com o Segredo do aplicativo da Meta em Configurações → Básico. O token de verificação do webhook e o token de acesso não substituem esse segredo.',
    )
  }

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Falha ao verificar os dados do número: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      const subscription = appSubscriptionState(subs, process.env.META_APP_ID)
      checks.waba_subscribed_to_app = subscription.subscribed && subscription.appIdMatch !== false
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          "O aplicativo configurado não está inscrito na conta do WhatsApp Business. Confira META_APP_ID e salve a configuração novamente para inscrevê-lo.",
        )
      }
    } catch (err) {
      errors.push(
        `Falha ao verificar a inscrição da conta do WhatsApp Business: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      "O ID da conta do WhatsApp Business não foi informado. Ele é necessário para os webhooks. Adicione-o no formulário e salve novamente.",
    )
  }

  const live =
    checks.webhook_secret_configured &&
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
