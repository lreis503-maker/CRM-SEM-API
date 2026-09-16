import { buildMediaPath, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';

export interface MirrorStorage {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array | Buffer,
      options: { contentType: string; cacheControl: string; upsert: boolean },
    ): Promise<{ error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
}

export const MIRROR_BUCKET = 'chat-media';
export const MIRROR_FOLDER = 'instagram-inbound';

async function defaultDownload(url: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: res.headers.get('content-type') };
}

function extensionFor(contentType: string | null, fallback: string): string {
  if (!contentType) return fallback;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[contentType.split(';')[0].trim()] ?? fallback;
}

/** Mirrors any inbound Instagram media URL (attachments or a profile
 *  picture) into the durable `chat-media` bucket. Instagram's CDN URLs
 *  are short-lived, so the DB should never store them directly.
 *  Best-effort: returns null on any failure so the caller can fall back
 *  to the (still-valid-for-now) original URL rather than fail the
 *  surrounding webhook/profile-fetch. */
export async function mirrorInstagramMedia(args: {
  storage: MirrorStorage;
  accountId: string;
  sourceUrl: string;
  /** Stable id to key the object path on — the message id for an
   *  attachment, the igsid for a profile picture — so repeated mirrors
   *  of the same thing overwrite instead of accumulating. */
  stableId: string;
  fallbackExtension: string;
  downloadFn?: typeof defaultDownload;
}): Promise<string | null> {
  const { storage, accountId, sourceUrl, stableId, fallbackExtension, downloadFn = defaultDownload } = args;
  try {
    const { buffer, contentType } = await downloadFn(sourceUrl);
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(`[instagram mirror-media] skipping ${stableId}: ${buffer.byteLength} bytes over limit`);
      return null;
    }
    const ext = extensionFor(contentType, fallbackExtension);
    const uploadType = contentType?.split(';')[0].trim() ?? 'application/octet-stream';
    const path = buildMediaPath(accountId, `${stableId}.${ext}`, null, MIRROR_FOLDER);
    const { error } = await storage.from(MIRROR_BUCKET).upload(path, buffer, {
      contentType: uploadType,
      cacheControl: '3600',
      upsert: true,
    });
    if (error) {
      console.warn(`[instagram mirror-media] upload failed for ${stableId}:`, error.message);
      return null;
    }
    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    return publicUrl || null;
  } catch (err) {
    console.warn(`[instagram mirror-media] could not mirror ${stableId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
