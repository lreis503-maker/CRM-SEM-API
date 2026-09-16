import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUazapiAvatarResolver } from './uazapi-avatar';
import type { UazapiInstanceClient } from '../providers/uazapi-client';

let getChatDetails: ReturnType<typeof vi.fn>;

function client(): UazapiInstanceClient {
  return {
    getChatDetails,
    downloadMessage: vi.fn(),
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
    findChats: vi.fn(),
    findMessages: vi.fn(),
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
  getChatDetails = vi.fn();
});

describe('createUazapiAvatarResolver — without mirroring', () => {
  it('returns the provider link as-is when storage is off', async () => {
    getChatDetails.mockResolvedValue({
      id: '5511999999999@s.whatsapp.net',
      imageUrl: 'https://tenant.uazapi.com/photos/ada.jpg',
    });

    const resolve = createUazapiAvatarResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
    });

    await expect(resolve('5511999999999')).resolves.toBe(
      'https://tenant.uazapi.com/photos/ada.jpg'
    );
    expect(getChatDetails).toHaveBeenCalledWith({
      number: '5511999999999',
      preview: true,
    });
  });

  it('returns null when the contact has no photo', async () => {
    getChatDetails.mockResolvedValue({ id: 'x@s.whatsapp.net', imageUrl: null });

    const resolve = createUazapiAvatarResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
    });

    await expect(resolve('5511999999999')).resolves.toBeNull();
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    getChatDetails.mockRejectedValue(new Error('not found'));

    const resolve = createUazapiAvatarResolver({
      client: client(),
      storage: null,
      accountId: 'acc-1',
    });

    await expect(resolve('5511999999999')).resolves.toBeNull();
  });
});

describe('createUazapiAvatarResolver — with mirroring', () => {
  it('copies the photo into storage and returns the durable URL', async () => {
    getChatDetails.mockResolvedValue({
      id: '5511999999999@s.whatsapp.net',
      imageUrl: 'https://tenant.uazapi.com/photos/ada.jpg',
    });
    const store = storage();

    const resolve = createUazapiAvatarResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      fetchImpl: fetchReturning(2048),
    });

    const url = await resolve('5511999999999');

    expect(store.uploads).toHaveLength(1);
    expect(store.uploads[0].path).toContain('avatar-5511999999999');
    expect(url).toBe(`https://cdn.test/chat-media/${store.uploads[0].path}`);
  });

  it('falls back to the provider link when the upload is refused', async () => {
    getChatDetails.mockResolvedValue({
      id: '5511999999999@s.whatsapp.net',
      imageUrl: 'https://tenant.uazapi.com/photos/ada.jpg',
    });
    const store = storage({ message: 'mime not allowed' });

    const resolve = createUazapiAvatarResolver({
      client: client(),
      storage: store.api,
      accountId: 'acc-1',
      fetchImpl: fetchReturning(2048),
    });

    await expect(resolve('5511999999999')).resolves.toBe(
      'https://tenant.uazapi.com/photos/ada.jpg'
    );
  });
});
