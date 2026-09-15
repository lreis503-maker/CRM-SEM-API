import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import type { WaContactPayload } from '@/lib/whatsapp/wa-identity'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import {
  isMetaReaction,
  normalizeMetaMessage,
  normalizeMetaStatus,
  type MetaInboundMessage,
  type MetaStatusError,
} from '@/lib/whatsapp/inbound/meta-normalizer'
import {
  processInboundMessage,
  resolveInboundParticipants,
} from '@/lib/whatsapp/inbound/process-inbound-message'
import { processStatusUpdate } from '@/lib/whatsapp/inbound/process-status-update'
import type {
  InboundMediaResolver,
  NormalizedMedia,
} from '@/lib/whatsapp/inbound/types'

// ============================================================
// The Meta Cloud API webhook.
//
// This route owns what is Meta's: signature verification, the Meta
// payload shape, template-lifecycle events, reactions, and fetching and
// mirroring media with the account's Meta access token.
//
// Everything after that — contacts, conversations, idempotency, unread
// counts, flow/automation/AI dispatch, public webhooks — lives in
// `@/lib/whatsapp/inbound`, shared with every other provider.
// ============================================================

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name?: string; username?: string }
        /** Absent for a username-only sender — see MetaInboundMessage. */
        wa_id?: string
        user_id?: string
        parent_user_id?: string
      }>
      messages?: MetaInboundMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        /**
         * Only present when `status === 'failed'`. Meta's reason for the
         * failure — `code` is a stable numeric error code (e.g. 131049),
         * `title` a short label, `error_data.details` the human-readable
         * explanation. See #535.
         */
        errors?: MetaStatusError[]
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: "Parâmetros de verificação ausentes" },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: "Falha na verificação" },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: "Erro interno do servidor" },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: "Assinatura inválida" }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      // `entry.id` is the WABA id for template events — the handler
      // needs it to resolve the owning account when the template has
      // no local row yet (#534).
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          {
            field: change.field,
            value: change.value as unknown,
            wabaId: entry.id,
          },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          const event = normalizeMetaStatus(status)
          if (!event) {
            console.warn('[webhook] unknown Meta status ignored:', status.status)
            continue
          }
          await processStatusUpdate({ db: supabaseAdmin(), event })
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find the account's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      //
      // Filtered to `provider = 'meta'`: only a Meta row has an access
      // token to decrypt, and a UAZAPI row has no phone_number_id at all.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .eq('provider', 'meta')

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await handleMetaMessage({
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          accountId: config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          configOwnerUserId: config.user_id,
          accessToken: decryptedAccessToken,
          // Default ON: the column is NOT NULL DEFAULT TRUE, but a row
          // read before migration 039 lands would have it undefined,
          // and losing attachments is the failure mode worth avoiding.
          mirrorMedia: config.mirror_inbound_media !== false,
        })
      }
    }
  }
}

/**
 * Fetch and mirror a Meta attachment, returning a durable URL.
 *
 * Strictly best-effort. `mirrorInboundMedia` swallows its own failures
 * and returns null, and we fall back to the `/api/whatsapp/media/<id>`
 * proxy URL — a webhook that throws would have Meta retry the delivery
 * and re-run everything downstream, which is far worse than an
 * attachment that expires.
 *
 * Mirroring exists because Meta deletes media ~30 days after receipt, so
 * the proxy URL is a pointer with an expiry date on it — every inbound
 * attachment silently became "Photo unavailable" a month later (#466).
 */
function metaMediaResolver(input: {
  accessToken: string
  mirrorAccountId: string | null
  messageTimestamp: string
}): InboundMediaResolver {
  return async (media: NormalizedMedia) => {
    const mediaId = media.locatorValue
    try {
      // getMediaUrl's signature is ({ mediaId, accessToken }) — earlier
      // code had the args swapped, so every verification hit an invalid
      // Meta URL and images showed up as empty bubbles in the inbox.
      const info = await getMediaUrl({ mediaId, accessToken: input.accessToken })

      if (input.mirrorAccountId) {
        const mirrored = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: input.mirrorAccountId,
          mediaId,
          downloadUrl: info.url,
          accessToken: input.accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName: media.fileName,
          messageTimestamp: input.messageTimestamp,
        })
        if (mirrored) return { url: mirrored, mimeType: media.mimeType }
      }

      return { url: `/api/whatsapp/media/${mediaId}`, mimeType: media.mimeType }
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return { url: null, mimeType: media.mimeType }
    }
  }
}

async function handleMetaMessage(input: {
  message: MetaInboundMessage
  contact: WaContactPayload | undefined
  accountId: string
  configOwnerUserId: string
  accessToken: string
  mirrorMedia: boolean
}) {
  const { message, contact, accountId, configOwnerUserId } = input

  const event = normalizeMetaMessage(message, contact)
  if (!event) {
    // Neither a phone number nor a BSUID. Creating a row anyway would
    // mean an unreachable contact that can never be matched again, so
    // drop the delivery loudly instead of accumulating them silently.
    console.error(
      '[webhook] inbound message carries neither a phone number nor a BSUID; skipping:',
      message.id
    )
    return
  }

  // Reactions are not messages: they are per-(target, actor) state, and
  // UAZAPI v1 has no equivalent, so they stay here rather than in the
  // shared processor. The participants still resolve first, so a thread
  // first opened by a reaction emits conversation.created.
  if (isMetaReaction(message)) {
    const participants = await resolveInboundParticipants({
      db: supabaseAdmin(),
      accountId,
      configOwnerUserId,
      sender: event.sender,
    })
    if (!participants) return
    await handleReaction(
      message,
      participants.conversation.id,
      participants.contact.id
    )
    return
  }

  await processInboundMessage({
    db: supabaseAdmin(),
    event,
    accountId,
    configOwnerUserId,
    resolveMedia: metaMediaResolver({
      accessToken: input.accessToken,
      mirrorAccountId: input.mirrorMedia ? accountId : null,
      messageTimestamp: message.timestamp,
    }),
  })
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a reaction to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('provider', 'meta')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: MetaInboundMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}
