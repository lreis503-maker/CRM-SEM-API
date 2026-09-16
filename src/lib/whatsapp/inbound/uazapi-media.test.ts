import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUazapiMediaResolver } from './uazapi-media';
import type { NormalizedMedia } from './types';
import type { UazapiInstanceClient } from '../providers/uazapi-client';

const LINKED: NormalizedMedia = {
  externalMediaId: 'msg-1',
  locator: 'provider_url',
  locatorValue: 'https://api.uazapi.com/files/a.jpg',
  mimeType: 'image/jpeg',
  fileName: null,
  fileSize: null,
};

const UNLINKED: NormalizedMedia = {
  ...LINKED,
  locator: 'provider_id',
  locatorValue: 'msg-1',
};

let downloadMessage: ReturnType<typeof vi.fn>;

function client(): UazapiInstanceClient {
  return {
    downloadMessage,
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
  } as unknown as UazapiInstanceClient;
}

function storage(uploadError: { message: string } | null = null) {
  const uploads: Array<{ path: string; bytes: number }> = [];
  return {
    uploads,
    api: {
      from: () => ({
        upload: async (path: string, body: Uint8Array) => {
          uploads.push({ path, bytes: body.byteLength });
          return { error: uploadError };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/chat-media/${path}` },
        }),
      }),
    },
  };
}

function fetchReturning(bytes: number, contentType = 'image/jpeg') {
  return vi.fn(
    async () =>
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': contentType },
      })
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  downloadMessage = vi.fn();
});

describe('createUazapiMediaResolver — without mirroring', () => {
  it('keeps the link the webhook already carried', async () => {
    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
    });

    await expect(resolve(LINKED)).resolves.toEqual({
      url: 'https://api.uazapi.com/files/a.jpg',
      mimeType: 'image/jpeg',
    });
    expect(downloadMessage).not.toHaveBeenCalled();
  });

  it('asks the provider for a link when the webhook carried none', async () => {
    downloadMessage.mockResolvedValue({
      fileUrl: 'https://api.uazapi.com/files/b.ogg',
      mimeType: 'audio/ogg',
    });

    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
    });

    await expect(resolve(UNLINKED)).resolves.toEqual({
      url: 'https://api.uazapi.com/files/b.ogg',
      mimeType: 'audio/ogg',
    });
    expect(downloadMessage).toHaveBeenCalledWith('msg-1');
  });

  it('stores the message without an attachment when the download fails', async () => {
    downloadMessage.mockRejectedValue(new Error('gone'));

    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
    });

    await expect(resolve(UNLINKED)).resolves.toEqual({
      url: null,
      mimeType: 'image/jpeg',
    });
  });
});

describe('createUazapiMediaResolver — with mirroring', () => {
  it('copies the bytes into storage before the provider expires them', async () => {
    const store = storage();
    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
      fetchImpl: fetchReturning(2048),
    });

    const result = await resolve(LINKED);

    expect(store.uploads).toHaveLength(1);
    // Keyed by the provider message id, so a redelivery rewrites the same
    // object rather than storing a second copy.
    expect(store.uploads[0].path).toContain('msg-1');
    expect(result.url).toBe(
      `https://cdn.test/chat-media/${store.uploads[0].path}`
    );
  });

  it('falls back to the provider link when the upload is refused', async () => {
    const store = storage({ message: 'mime not allowed' });
    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
      fetchImpl: fetchReturning(2048),
    });

    await expect(resolve(LINKED)).resolves.toMatchObject({
      url: 'https://api.uazapi.com/files/a.jpg',
    });
  });

  it('refuses a file larger than the bucket allows', async () => {
    const store = storage();
    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
      fetchImpl: fetchReturning(20 * 1024 * 1024),
    });

    await expect(resolve(LINKED)).resolves.toMatchObject({
      url: 'https://api.uazapi.com/files/a.jpg',
    });
    expect(store.uploads).toHaveLength(0);
  });

  it('falls back to the link when the download itself fails', async () => {
    const store = storage();
    const resolve = createUazapiMediaResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      occurredAt: '2026-09-15T12:00:00.000Z',
      fetchImpl: vi.fn(
        async () => new Response('nope', { status: 404 })
      ) as unknown as typeof fetch,
    });

    await expect(resolve(LINKED)).resolves.toMatchObject({
      url: 'https://api.uazapi.com/files/a.jpg',
    });
    expect(store.uploads).toHaveLength(0);
  });
});
