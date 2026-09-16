// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import crypto from 'crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import { assertProviderCapability } from '@/lib/whatsapp/providers/capabilities';
import { loadProviderTransport } from '@/lib/whatsapp/providers/send-provider-message';
import type { ProviderMediaKind } from '@/lib/whatsapp/providers/provider-transport';
import { resolveProviderSendTarget } from '@/lib/whatsapp/providers/resolve-send-target';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { isUazapiClientError } from '@/lib/whatsapp/providers/uazapi-errors';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { SendMessageError } from './send-message-error';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

// Re-exported from its own module so the provider adapters can raise it
// without importing this file, which imports them.
export { SendMessageError } from './send-message-error';

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', "O tipo de mensagem é obrigatório", 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Tipo de mensagem não compatível: "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      "O conteúdo de texto é obrigatório para mensagens de texto",
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      "O nome do modelo é obrigatório para mensagens de modelo",
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `A URL da mídia é obrigatória para ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      "A legenda excede o limite de 1024 caracteres",
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      "O ID da conversa é obrigatório",
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', "Conversa não encontrada", 404);
  }

  const contact = conversation.contact;

  // Which provider is active decides both the transport and what counts
  // as an address, so it is resolved before anything else. Meta-only
  // message types are refused here, before a template row is read or a
  // credential is decrypted.
  const { provider, transport, config, accessToken } =
    await loadProviderTransport(db, accountId);

  if (messageType === 'template') {
    assertProviderCapability(provider, 'templates');
  }
  if (messageType === 'interactive') {
    assertProviderCapability(provider, 'interactive');
  }

  // A contact is addressable by phone number OR by a provider-specific
  // identifier: a Meta business-scoped user ID for a customer who adopted
  // a WhatsApp username (issue #519), or a stored UAZAPI LID. Phone stays
  // preferred: only it supports the trunk-prefix variant retry below.
  const resolvedTarget = await resolveProviderSendTarget(
    db,
    accountId,
    provider,
    contact
  );
  const sendTarget = resolvedTarget.target;
  const hasValidPhone = resolvedTarget.isPhone;
  const sanitizedPhone = hasValidPhone ? sendTarget : '';

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (accessToken !== null && isLegacyFormat(String(config.access_token))) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        "A mensagem citada não foi encontrada nesta conversa",
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        "O modelo salvo está inválido. Use \"Sincronizar com a Meta\" em Configurações para corrigi-lo.",
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  // Generated before the send so it can travel with the message as the
  // provider tracking id, and so the persisted row uses the same id.
  const localMessageId = crypto.randomUUID();

  const attempt = async (phone: string): Promise<string> => {
    // Templates and interactive messages have no shared contract: they
    // stay on the Meta path, already gated by the capability check above.
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id as string,
        accessToken: accessToken as string,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id as string,
          accessToken: accessToken as string,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id as string,
        accessToken: accessToken as string,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }

    const result = await transport.send(
      phone,
      isMediaKind
        ? {
            kind: 'media',
            mediaKind: messageType as ProviderMediaKind,
            url: mediaUrl!,
            caption: contentText || undefined,
            filename: filename || undefined,
            replyToExternalId: contextMessageId,
            trackId: localMessageId,
          }
        : {
            kind: 'text',
            text: contentText!,
            replyToExternalId: contextMessageId,
            trackId: localMessageId,
          }
    );
    return result.externalMessageId;
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sendTarget;
  try {
    // Variants only make sense for a Meta phone number — a BSUID is
    // opaque, and a UAZAPI send is never repeated, because a second
    // attempt could deliver the same message to a real person twice.
    const variants =
      provider === 'meta' && hasValidPhone
        ? phoneVariants(sanitizedPhone)
        : [sendTarget];
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    if (provider === 'uazapi') {
      // The upstream detail stays server-side: a UAZAPI error body can
      // echo a token back at us. The caller gets a stable code, and an
      // ambiguous send is surfaced as failed rather than retried.
      console.error('[send-message] UAZAPI send failed:', {
        code: isUazapiClientError(err) ? err.kind : 'unknown_error',
        ambiguous: isUazapiClientError(err) ? err.ambiguous : null,
      });
      throw new SendMessageError(
        'provider_error',
        "Não foi possível enviar a mensagem pela conexão do WhatsApp. Confira o estado da conexão e envie novamente.",
        502
      );
    }

    const message =
      err instanceof Error ? err.message : "Erro desconhecido na API da Meta";
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Erro na API da Meta: ${message}`, 502);
  }

  if (hasValidPhone && workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      id: localMessageId,
      conversation_id: conversationId,
      provider,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Mensagem enviada para a Meta, mas não foi possível salvar no banco de dados: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
