/**
 * The contract both providers implement.
 *
 * Only the operations that are genuinely common live here: one-to-one
 * text and media. Everything Meta-only — templates, interactive
 * messages, reactions, location — is deliberately absent, so UAZAPI never
 * has to pretend to implement it.
 */

import type { WhatsAppProvider } from './types';

/** Media kinds the CRM shares across providers. */
export type ProviderMediaKind = 'image' | 'video' | 'audio' | 'document';

export type ProviderMessageInput =
  | {
      kind: 'text';
      text: string;
      /** Provider message id being replied to, when quoting. */
      replyToExternalId?: string;
      /**
       * The CRM's own message id. Used for diagnostics only: the UAZAPI
       * contract states tracking ids may repeat, so it is never an
       * idempotency key.
       */
      trackId: string;
    }
  | {
      kind: 'media';
      mediaKind: ProviderMediaKind;
      url: string;
      caption?: string;
      filename?: string;
      replyToExternalId?: string;
      trackId: string;
    };

export interface ProviderSendResult {
  provider: WhatsAppProvider;
  /** The provider's id for the message, used to match status updates. */
  externalMessageId: string;
  status: 'sent';
}

export interface ProviderTransport {
  provider: WhatsAppProvider;
  /** Exactly one attempt. Retrying is the caller's decision, never ours. */
  send(
    target: string,
    message: ProviderMessageInput
  ): Promise<ProviderSendResult>;
}
