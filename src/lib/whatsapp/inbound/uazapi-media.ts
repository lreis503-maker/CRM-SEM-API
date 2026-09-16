/**
 * Inbound media for UAZAPI.
 *
 * UAZAPI keeps hosted media for two days, so when the account has
 * mirroring on the bytes are copied into `chat-media` immediately — the
 * same durable home outbound media already uses. With mirroring off the
 * provider link is stored as-is, which matches what that setting
 * promises: media lives as long as the provider keeps it.
 *
 * Everything here is best-effort: a failure returns the provider link, or
 * null, and the message is still stored. A webhook that throws would have
 * the provider redeliver and re-run contacts, flows and automations,
 * which is far worse than an attachment that expires.
 */

import { mirrorInboundMedia, normalizeMimeType } from '../mirror-inbound-media';
import { MEDIA_MAX_BYTES } from '../../storage/upload-media';
import type { UazapiInstanceClient } from '../providers/uazapi-client';
import type { InboundMediaResolver, NormalizedMedia } from './types';

/** A hosted file should arrive well inside this. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface UazapiMediaResolverInput {
  client: UazapiInstanceClient;
  /** Service-role `supabase.storage`. Null disables mirroring. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: any | null;
  accountId: string;
  /** Message timestamp, so mirrored names stay distinct and stable. */
  occurredAt: string;
  fetchImpl?: typeof fetch;
}

/**
 * Plain HTTPS fetch of a provider-hosted file. The link is public and
 * short-lived, so there is no credential to send — the `accessToken`
 * argument exists only because the shared mirror helper is written
 * against Meta's downloader shape.
 */
function publicDownloader(fetchImpl: typeof fetch) {
  return async ({ downloadUrl }: { downloadUrl: string }) => {
    const response = await fetchImpl(downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`media download failed with HTTP ${response.status}`);
    }

    const declared = Number(response.headers?.get?.('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
      throw new Error(`media is ${declared} bytes, over the bucket limit`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      throw new Error(
        `media is ${buffer.byteLength} bytes, over the bucket limit`
      );
    }

    return {
      buffer,
      contentType: response.headers?.get?.('content-type') ?? '',
    };
  };
}

/**
 * Resolves the link for a media message, asking `/message/download` for
 * one when the webhook did not carry it.
 */
async function resolveProviderUrl(
  media: NormalizedMedia,
  client: UazapiInstanceClient
): Promise<{ url: string | null; mimeType: string | null }> {
  if (media.locator === 'provider_url') {
    return { url: media.locatorValue, mimeType: media.mimeType };
  }

  try {
    // `return_base64: false` — the bytes never pass through this process
    // just to be handed straight back to storage.
    const downloaded = await client.downloadMessage(media.locatorValue);
    return {
      url: downloaded.fileUrl,
      mimeType: downloaded.mimeType ?? media.mimeType,
    };
  } catch (error) {
    console.error(
      `[uazapi-media] download failed for ${media.externalMediaId}:`,
      error instanceof Error ? error.name : error
    );
    return { url: null, mimeType: media.mimeType };
  }
}

export function createUazapiMediaResolver(
  input: UazapiMediaResolverInput
): InboundMediaResolver {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return async (media: NormalizedMedia) => {
    const resolved = await resolveProviderUrl(media, input.client);
    if (resolved.url === null) return resolved;

    // Mirroring off: keep the provider link and accept its two-day life,
    // which is exactly what the account-level setting opts into.
    if (!input.storage) return resolved;

    const mirrored = await mirrorInboundMedia({
      storage: input.storage,
      accountId: input.accountId,
      // The provider message id keeps the storage path deterministic, so
      // a redelivery rewrites the same object instead of duplicating it.
      mediaId: media.externalMediaId,
      downloadUrl: resolved.url,
      mimeType: normalizeMimeType(resolved.mimeType),
      fileSize: media.fileSize,
      fileName: media.fileName,
      messageTimestamp: Date.parse(input.occurredAt) || null,
      download: publicDownloader(fetchImpl),
    });

    return {
      url: mirrored ?? resolved.url,
      mimeType: resolved.mimeType,
    };
  };
}
