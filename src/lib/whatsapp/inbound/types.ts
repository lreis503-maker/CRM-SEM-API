/**
 * The provider-neutral shape of an inbound WhatsApp event.
 *
 * Each provider route owns authentication and its own payload parsing,
 * then hands one of these envelopes to the shared processors. Everything
 * downstream — contacts, conversations, idempotency, unread counts, flow
 * and automation dispatch, public webhooks — works only from this shape,
 * so adding a provider never means touching that logic again.
 *
 * Meta-only concepts stay out of the envelope on purpose: template
 * lifecycle events and reactions are handled inside the Meta route,
 * because UAZAPI v1 has no equivalent and inventing a shared contract for
 * them would be guessing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  WhatsAppConnectionStatus,
  WhatsAppProvider,
} from '../providers/types';

/** How a provider points at a media file it delivered. */
export interface NormalizedMedia {
  /** The provider's id for the file, used for idempotent storage paths. */
  externalMediaId: string;
  /**
   * `provider_id` means the file must be fetched through the provider's
   * API (Meta); `provider_url` means the payload carried a direct link
   * (UAZAPI).
   */
  locator: 'provider_id' | 'provider_url';
  locatorValue: string;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
}

export type NormalizedSenderIdKind = 'bsuid' | 'lid' | 'jid';

export interface NormalizedSender {
  /** Digits-only phone, or `''` when the provider withheld it. */
  phone: string;
  /** Provider-specific identifier, when one was supplied. */
  externalId: string | null;
  externalIdKind: NormalizedSenderIdKind | null;
  /** Meta's portfolio-level id. Null for every other provider. */
  parentExternalId: string | null;
  /**
   * The profile name the provider actually supplied, or null. Distinct
   * from `displayName` on purpose: backfilling a matched contact must not
   * overwrite an agent's hand-edited name with a fallback.
   */
  profileName: string | null;
  /** Name to use when creating a row; falls back to the phone or id. */
  displayName: string;
  username: string | null;
}

export type NormalizedContent =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'video' | 'audio' | 'document';
      text: string | null;
      /** Null when the provider announced media but sent no locator. */
      media: NormalizedMedia | null;
    }
  | { type: 'location'; text: string }
  | { type: 'interactive'; text: string; replyId: string | null };

export interface NormalizedInboundMessage {
  kind: 'message';
  provider: WhatsAppProvider;
  externalMessageId: string;
  /** ISO timestamp, already converted from the provider's own units. */
  occurredAt: string;
  fromMe: boolean;
  isGroup: boolean;
  sender: NormalizedSender;
  content: NormalizedContent;
  /** The provider id of the message being replied to, when quoting. */
  replyToExternalId: string | null;
}

export interface NormalizedStatusUpdate {
  kind: 'status';
  provider: WhatsAppProvider;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: string;
  failure: {
    code: string | null;
    title: string | null;
    details: string | null;
  } | null;
}

export interface NormalizedConnectionUpdate {
  kind: 'connection';
  provider: WhatsAppProvider;
  status: Exclude<WhatsAppConnectionStatus, 'not_configured'>;
  occurredAt: string;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export type NormalizedInboundEvent =
  | NormalizedInboundMessage
  | NormalizedStatusUpdate
  | NormalizedConnectionUpdate;

/**
 * Raised when processing failed for a reason that may succeed on a retry
 * — a database or storage blip. Provider routes turn it into a 503 so the
 * provider redelivers, instead of acknowledging a message we dropped.
 */
export class TransientInboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientInboundError';
  }
}

/**
 * Turns a media locator into a durable URL. Provider-specific: Meta
 * verifies the id and mirrors the bytes, UAZAPI uses the supplied link or
 * asks for one. Returning a null url means the attachment is unavailable;
 * the message is still stored without it.
 */
export type InboundMediaResolver = (
  media: NormalizedMedia
) => Promise<{ url: string | null; mimeType: string | null }>;

/**
 * Always the service-role client: inbound processing has no session to
 * scope by, and it writes tables no browser policy allows.
 */
export type InboundDatabase = SupabaseClient;
