/**
 * Inbound contact avatar for UAZAPI.
 *
 * The webhook payload for a message never carries the sender's photo —
 * confirmed against live-captured fixtures (`uazapi-normalizer.live.test.ts`)
 * — so it has to be asked for separately, through `/chat/details`. That is
 * the only documented endpoint that returns one.
 *
 * Mirrors `./uazapi-media`'s shape on purpose: same best-effort contract
 * (a failure here returns null, never throws), same storage toggle, same
 * public downloader. A contact photo is not worth a webhook 503 — that
 * would make the provider redeliver the whole message and re-run contact
 * creation, flows and automations for the sake of an avatar.
 */

import { mirrorInboundMedia } from '../mirror-inbound-media';
import type { UazapiInstanceClient } from '../providers/uazapi-client';
import type { InboundAvatarResolver } from './types';

const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface UazapiAvatarResolverInput {
  client: UazapiInstanceClient;
  /** Service-role `supabase.storage`. Null disables mirroring. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: any | null;
  accountId: string;
  fetchImpl?: typeof fetch;
}

/** Same plain, credential-free fetch `./uazapi-media` uses: the link is public. */
function publicDownloader(fetchImpl: typeof fetch) {
  return async ({ downloadUrl }: { downloadUrl: string }) => {
    const response = await fetchImpl(downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`avatar download failed with HTTP ${response.status}`);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers?.get?.('content-type') ?? '',
    };
  };
}

export function createUazapiAvatarResolver(
  input: UazapiAvatarResolverInput
): InboundAvatarResolver {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return async (chatId: string) => {
    let details;
    try {
      // `preview: true` — an avatar is shown small and round; the full-
      // resolution original the default returns would just be wasted
      // bytes on both the download and the mirrored copy.
      details = await input.client.getChatDetails({
        number: chatId,
        preview: true,
      });
    } catch (error) {
      console.error(
        `[uazapi-avatar] lookup failed for ${chatId}:`,
        error instanceof Error ? error.name : error
      );
      return null;
    }

    if (!details?.imageUrl) return null;

    // Mirroring off: the provider link is returned as-is, same tradeoff
    // the account already accepted for message media.
    if (!input.storage) return details.imageUrl;

    const mirrored = await mirrorInboundMedia({
      storage: input.storage,
      accountId: input.accountId,
      // Keyed by the chat, not a message id: the next inbound message
      // from the same contact reuses this exact path, so a backfill
      // overwrites the same object instead of piling up copies.
      mediaId: `avatar-${chatId}`,
      downloadUrl: details.imageUrl,
      mimeType: null,
      download: publicDownloader(fetchImpl),
    });

    return mirrored ?? details.imageUrl;
  };
}
