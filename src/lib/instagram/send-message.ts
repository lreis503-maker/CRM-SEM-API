import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sendInstagramAttachmentMessage,
  sendInstagramTextMessage,
  type InstagramOutboundAttachmentType,
} from './graph-api';
import { isMessagingWindowOpen } from './messaging-window';

export class InstagramSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstagramSendError';
  }
}

export interface SendInstagramMessageParams {
  conversationId: string;
  contentType: 'text' | InstagramOutboundAttachmentType;
  contentText?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

export interface SendInstagramMessageResult {
  messageId: string;
  igMessageId: string;
}

export function validateSendInstagramMessageParams(params: {
  contentType: string;
  contentText?: string;
  mediaUrl?: string;
}) {
  if (params.contentType === 'text') {
    if (!params.contentText || !params.contentText.trim()) {
      throw new InstagramSendError('O texto da mensagem é obrigatório', 400);
    }
    if (params.contentText.length > 1000) {
      throw new InstagramSendError('O texto deve ter no máximo 1000 caracteres', 400);
    }
    return;
  }
  if (!params.mediaUrl) {
    throw new InstagramSendError('A URL da mídia é obrigatória', 400);
  }
}

export async function sendInstagramMessage(
  supabase: SupabaseClient,
  accountId: string,
  params: SendInstagramMessageParams,
): Promise<SendInstagramMessageResult> {
  validateSendInstagramMessageParams(params);

  const { data: conversation, error: convError } = await supabase
    .from('instagram_conversations')
    .select('id, account_id, contact_id, last_customer_message_at, instagram_contacts(igsid)')
    .eq('id', params.conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (convError || !conversation) {
    throw new InstagramSendError('Conversa não encontrada', 404);
  }

  if (!isMessagingWindowOpen(conversation.last_customer_message_at)) {
    throw new InstagramSendError(
      'A janela de 24h para responder esta conversa expirou. Aguarde uma nova mensagem do cliente.',
      409,
    );
  }

  const { data: config, error: configError } = await supabase
    .from('instagram_config')
    .select('page_access_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (configError || !config) {
    throw new InstagramSendError('Instagram não está conectado nesta conta', 409);
  }

  const igsid = (
    conversation as unknown as { instagram_contacts: { igsid: string } }
  ).instagram_contacts.igsid;
  const pageAccessToken = decrypt(config.page_access_token);

  let replyToMid: string | undefined;
  if (params.replyToMessageId) {
    const { data: replyTarget } = await supabase
      .from('instagram_messages')
      .select('ig_message_id')
      .eq('id', params.replyToMessageId)
      .eq('conversation_id', params.conversationId)
      .maybeSingle();
    replyToMid = replyTarget?.ig_message_id ?? undefined;
  }

  let sendResult;
  try {
    sendResult =
      params.contentType === 'text'
        ? await sendInstagramTextMessage({
            igsid,
            pageAccessToken,
            text: params.contentText!.trim(),
            replyToMid,
          })
        : await sendInstagramAttachmentMessage({
            igsid,
            pageAccessToken,
            attachmentType: params.contentType,
            mediaUrl: params.mediaUrl!,
            replyToMid,
          });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao enviar mensagem ao Instagram';
    await supabase.from('instagram_messages').insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      content_type: params.contentType,
      content_text: params.contentText ?? null,
      media_url: params.mediaUrl ?? null,
      status: 'failed',
      error_message: message,
      reply_to_message_id: params.replyToMessageId ?? null,
    });
    throw new InstagramSendError(message, 502);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('instagram_messages')
    .insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      content_type: params.contentType,
      content_text: params.contentText ?? null,
      media_url: params.mediaUrl ?? null,
      ig_message_id: sendResult.messageId,
      status: 'sent',
      reply_to_message_id: params.replyToMessageId ?? null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new InstagramSendError('Mensagem enviada, mas não foi possível salvá-la', 500);
  }

  await supabase
    .from('instagram_conversations')
    .update({
      last_message_text: params.contentType === 'text' ? params.contentText : `[${params.contentType}]`,
      last_message_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId);

  return { messageId: inserted.id, igMessageId: sendResult.messageId };
}
