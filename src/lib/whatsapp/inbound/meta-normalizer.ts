/**
 * Meta Cloud API payload -> the provider-neutral envelope.
 *
 * Pure and synchronous: it decides what a message *is*, never what to do
 * about it. Media is described by its Meta id; fetching and mirroring the
 * bytes is the route's job, because only it holds the access token.
 *
 * Reactions and template-lifecycle events are deliberately not
 * normalizable — they stay inside the Meta route. `isMetaReaction` is
 * exported so the route can branch before calling this.
 */

import {
  hasUsableIdentity,
  identityDisplayName,
  resolveInboundIdentity,
  type WaContactPayload,
} from '../wa-identity';
import type {
  NormalizedContent,
  NormalizedInboundMessage,
  NormalizedMedia,
  NormalizedSender,
  NormalizedStatusUpdate,
} from './types';

/** The subset of Meta's message envelope the normalizer reads. */
export interface MetaInboundMessage {
  id: string;
  from?: string;
  from_user_id?: string;
  from_parent_user_id?: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text?: string; payload?: string };
  context?: { id: string };
}

export interface MetaStatusError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details?: string };
  href?: string;
}

export interface MetaStatusPayload {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: MetaStatusError[];
}

/** Reactions are per-(target, actor) state, not messages. Meta-only. */
export function isMetaReaction(message: MetaInboundMessage): boolean {
  return message.type === 'reaction';
}

function metaTimestampToIso(timestamp: string): string {
  // Meta sends seconds since the epoch, as a string.
  return new Date(parseInt(timestamp, 10) * 1000).toISOString();
}

function mediaFrom(
  id: string | undefined,
  mimeType: string | undefined,
  fileName?: string | null
): NormalizedMedia | null {
  if (!id) return null;
  return {
    externalMediaId: id,
    locator: 'provider_id',
    locatorValue: id,
    mimeType: mimeType ?? null,
    fileName: fileName ?? null,
    fileSize: null,
  };
}

function normalizeContent(message: MetaInboundMessage): NormalizedContent {
  switch (message.type) {
    case 'text':
      return { type: 'text', text: message.text?.body || '' };

    case 'image':
      return {
        type: 'image',
        text: message.image?.caption || null,
        media: mediaFrom(message.image?.id, message.image?.mime_type),
      };

    case 'video':
      return {
        type: 'video',
        text: message.video?.caption || null,
        media: mediaFrom(message.video?.id, message.video?.mime_type),
      };

    case 'document':
      return {
        type: 'document',
        text: message.document?.caption || message.document?.filename || null,
        // The sender's own filename becomes the mirrored object's name, so
        // saving the attachment yields `invoice.pdf` even when a caption
        // displaced the filename in the message text.
        media: mediaFrom(
          message.document?.id,
          message.document?.mime_type,
          message.document?.filename
        ),
      };

    case 'audio':
      return {
        type: 'audio',
        text: null,
        media: mediaFrom(message.audio?.id, message.audio?.mime_type),
      };

    case 'sticker':
      // Stickers are images under the hood, and the messages content_type
      // constraint has no 'sticker'.
      return {
        type: 'image',
        text: null,
        media: mediaFrom(message.sticker?.id, message.sticker?.mime_type),
      };

    case 'location': {
      const loc = message.location;
      if (!loc) return { type: 'text', text: '' };
      return {
        type: 'location',
        text: [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - '),
      };
    }

    case 'interactive': {
      // The customer tapped a reply button or a list row. The title is what
      // the inbox shows; the id is what the Flows engine routes on.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        return {
          type: 'interactive',
          text: reply.title || reply.id,
          replyId: reply.id,
        };
      }
      return {
        type: 'interactive',
        text: '[Interactive reply]',
        replyId: null,
      };
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta uses its own envelope
      // here rather than `interactive` (issue #478): `payload` is the
      // stable value, `text` the visible label, and a template may carry
      // only one of them.
      const payload = message.button?.payload || null;
      const label = message.button?.text || null;
      return {
        type: 'interactive',
        text: label || payload || '',
        replyId: payload || label,
      };
    }

    default:
      return {
        type: 'text',
        text: `[Tipo de mensagem não compatível: ${message.type}]`,
      };
  }
}

function normalizeSender(
  message: MetaInboundMessage,
  contact: WaContactPayload | undefined
): NormalizedSender | null {
  const identity = resolveInboundIdentity(message, contact);
  // Neither key present: a row created from this would be an unreachable
  // contact that can never be matched again.
  if (!hasUsableIdentity(identity)) return null;

  return {
    phone: identity.phone,
    externalId: identity.waUserId,
    externalIdKind: identity.waUserId ? 'bsuid' : null,
    parentExternalId: identity.waParentUserId,
    profileName: identity.name || null,
    displayName: identityDisplayName(identity),
    username: identity.waUsername,
  };
}

/**
 * Returns the envelope, or null when the payload carries no usable
 * sender identity. Callers log and skip on null rather than storing a
 * contact nothing can ever address.
 */
export function normalizeMetaMessage(
  message: MetaInboundMessage,
  contact: WaContactPayload | undefined
): NormalizedInboundMessage | null {
  const sender = normalizeSender(message, contact);
  if (!sender) return null;

  return {
    kind: 'message',
    provider: 'meta',
    externalMessageId: message.id,
    occurredAt: metaTimestampToIso(message.timestamp),
    // Meta's messages webhook only delivers inbound one-to-one messages,
    // so both flags are constant here. They exist for UAZAPI, which does
    // deliver echoes and group traffic.
    fromMe: false,
    isGroup: false,
    sender,
    // Meta's messages webhook only delivers inbound one-to-one messages,
    // so the thread is always the sender.
    chat: {
      externalId: sender.externalId,
      phone: sender.phone,
      isGroup: false,
      name: null,
    },
    content: normalizeContent(message),
    replyToExternalId: message.context?.id ?? null,
  };
}

const STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
type KnownStatus = (typeof STATUSES)[number];

function isKnownStatus(value: string): value is KnownStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * Returns the envelope, or null for a status value outside the four the
 * CRM tracks, which is left alone rather than written as an unknown.
 */
export function normalizeMetaStatus(
  status: MetaStatusPayload
): NormalizedStatusUpdate | null {
  if (!isKnownStatus(status.status)) return null;

  // Only read on `failed`, so a later non-failed status for the same id
  // leaves the recorded reason in place instead of clearing it.
  const error = status.status === 'failed' ? status.errors?.[0] : undefined;

  return {
    kind: 'status',
    provider: 'meta',
    externalMessageId: status.id,
    status: status.status,
    occurredAt: metaTimestampToIso(status.timestamp),
    failure: error
      ? {
          code: String(error.code),
          title: error.title,
          details: error.error_data?.details ?? null,
        }
      : null,
  };
}
