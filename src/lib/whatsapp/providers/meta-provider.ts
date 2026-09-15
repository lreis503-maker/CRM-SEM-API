/**
 * Meta adapter for the shared text/media transport.
 *
 * It is a wrapper and nothing more: the payloads handed to `meta-api` are
 * byte-for-byte what they were before providers existed. Templates,
 * interactive messages, reactions and the phone-variant retry stay where
 * they are — they are Meta-only behaviour with no shared contract, and
 * moving them here would be inventing one.
 */

import { sendMediaMessage, sendTextMessage, type MediaKind } from '../meta-api';
import type {
  ProviderMessageInput,
  ProviderSendResult,
  ProviderTransport,
} from './provider-transport';

export interface MetaSendFunctions {
  sendText: typeof sendTextMessage;
  sendMedia: typeof sendMediaMessage;
}

export interface MetaProviderInput {
  phoneNumberId: string;
  accessToken: string;
  /** Injectable for tests; defaults to the real Graph API helpers. */
  fns?: MetaSendFunctions;
}

export function createMetaProvider(
  input: MetaProviderInput
): ProviderTransport {
  const fns: MetaSendFunctions = input.fns ?? {
    sendText: sendTextMessage,
    sendMedia: sendMediaMessage,
  };

  return {
    provider: 'meta',

    async send(
      target: string,
      message: ProviderMessageInput
    ): Promise<ProviderSendResult> {
      // `trackId` is deliberately dropped: it is a CRM-side diagnostic and
      // Meta has no field for it.
      const contextMessageId = message.replyToExternalId ?? undefined;

      if (message.kind === 'text') {
        const result = await fns.sendText({
          phoneNumberId: input.phoneNumberId,
          accessToken: input.accessToken,
          to: target,
          text: message.text,
          contextMessageId,
        });
        return {
          provider: 'meta',
          externalMessageId: result.messageId,
          status: 'sent',
        };
      }

      const result = await fns.sendMedia({
        phoneNumberId: input.phoneNumberId,
        accessToken: input.accessToken,
        to: target,
        kind: message.mediaKind as MediaKind,
        link: message.url,
        caption: message.caption || undefined,
        filename: message.filename || undefined,
        contextMessageId,
      });

      return {
        provider: 'meta',
        externalMessageId: result.messageId,
        status: 'sent',
      };
    },
  };
}
