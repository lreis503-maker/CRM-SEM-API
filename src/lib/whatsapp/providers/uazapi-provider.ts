/**
 * UAZAPI adapter for the shared text/media transport.
 *
 * It maps CRM concepts onto the documented `/send/text` and `/send/media`
 * fields and does nothing else. In particular it never retries: the
 * client makes one attempt, and a send whose outcome is unknown is
 * reported as failed rather than repeated, because repeating it could
 * deliver the same message to a real person twice.
 */

import type {
  ProviderMediaKind,
  ProviderMessageInput,
  ProviderSendResult,
  ProviderTransport,
} from './provider-transport';
import type { UazapiInstanceClient, UazapiMediaType } from './uazapi-client';

/** Identifies CRM traffic in the provider's own message list. */
const TRACK_SOURCE = 'wacrm';

/**
 * Audio becomes a voice message: that is what an audio reply is in a
 * WhatsApp conversation, and `ptt` is UAZAPI's name for it.
 */
const MEDIA_TYPES: Record<ProviderMediaKind, UazapiMediaType> = {
  image: 'image',
  video: 'video',
  audio: 'ptt',
  document: 'document',
};

export function createUazapiProvider(
  client: UazapiInstanceClient
): ProviderTransport {
  return {
    provider: 'uazapi',

    async send(
      target: string,
      message: ProviderMessageInput
    ): Promise<ProviderSendResult> {
      const replyId = message.replyToExternalId ?? undefined;

      if (message.kind === 'text') {
        const result = await client.sendText({
          number: target,
          text: message.text,
          replyId,
          trackSource: TRACK_SOURCE,
          trackId: message.trackId,
        });
        return {
          provider: 'uazapi',
          externalMessageId: result.messageId,
          status: 'sent',
        };
      }

      const type = MEDIA_TYPES[message.mediaKind];
      const result = await client.sendMedia({
        number: target,
        type,
        file: message.url,
        caption: message.caption || undefined,
        // Only documents carry a visible file name; sending one on an
        // image would show a filename where a caption belongs.
        docName:
          type === 'document' ? message.filename || undefined : undefined,
        replyId,
        trackSource: TRACK_SOURCE,
        trackId: message.trackId,
      });

      return {
        provider: 'uazapi',
        externalMessageId: result.messageId,
        status: 'sent',
      };
    },
  };
}
