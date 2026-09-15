import { describe, expect, it, vi } from 'vitest';

import {
  createUazapiAdminClient,
  createUazapiInstanceClient,
  normalizeUazapiQrCode,
} from './uazapi-client';
import { isUazapiClientError } from './uazapi-errors';

const BASE_URL = 'https://tenant.uazapi.com';
const ADMIN_TOKEN = 'admin-secret';
const INSTANCE_TOKEN = 'plain-instance-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchReturning(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(jsonResponse(body, status));
}

function adminClient(fetchImpl: typeof fetch | ReturnType<typeof vi.fn>) {
  return createUazapiAdminClient({
    baseUrl: BASE_URL,
    adminToken: ADMIN_TOKEN,
    fetch: fetchImpl as typeof fetch,
  });
}

function instanceClient(fetchImpl: typeof fetch | ReturnType<typeof vi.fn>) {
  return createUazapiInstanceClient({
    baseUrl: BASE_URL,
    instanceToken: INSTANCE_TOKEN,
    fetch: fetchImpl as typeof fetch,
  });
}

function lastInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit & {
  headers: Record<string, string>;
} {
  return fetchImpl.mock.calls.at(-1)?.[1] as RequestInit & {
    headers: Record<string, string>;
  };
}

function lastBody(
  fetchImpl: ReturnType<typeof vi.fn>
): Record<string, unknown> {
  return JSON.parse(String(lastInit(fetchImpl).body)) as Record<
    string,
    unknown
  >;
}

describe('createUazapiAdminClient', () => {
  it('uses admintoken only when creating an instance', async () => {
    const fetchImpl = fetchReturning({ id: 'i-1', token: 't-1' });
    const client = adminClient(fetchImpl);

    await client.createInstance({ name: 'wacrm-acc-1-a1b2' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/instance/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ admintoken: ADMIN_TOKEN }),
      })
    );
    expect(lastInit(fetchImpl).headers).not.toHaveProperty('token');
    expect(lastBody(fetchImpl)).toEqual({ name: 'wacrm-acc-1-a1b2' });
  });

  it('reads the created instance from the documented nested shape', async () => {
    const fetchImpl = fetchReturning({
      response: 'Instance created successfully',
      instance: { id: 'i-9', name: 'wacrm-acc-1-a1b2', status: 'disconnected' },
      token: 't-9',
    });

    const created = await adminClient(fetchImpl).createInstance({
      name: 'wacrm-acc-1-a1b2',
    });

    expect(created.token).toBe('t-9');
    expect(created.instance).toMatchObject({
      id: 'i-9',
      name: 'wacrm-acc-1-a1b2',
      status: 'disconnected',
    });
  });

  it('rejects a response without a usable instance id or token', async () => {
    const fetchImpl = fetchReturning({ response: 'ok' });

    await expect(
      adminClient(fetchImpl).createInstance({ name: 'wacrm-acc-1-a1b2' })
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('refuses an installation base URL that is not plain HTTPS', () => {
    const rejected = [
      'http://tenant.uazapi.com',
      'https://user:pass@tenant.uazapi.com',
      'https://tenant.uazapi.com/api/v1',
      'not-a-url',
      '',
    ];

    for (const baseUrl of rejected) {
      let caught: unknown;
      try {
        createUazapiAdminClient({
          baseUrl,
          adminToken: ADMIN_TOKEN,
          fetch: vi.fn() as unknown as typeof fetch,
        });
      } catch (error) {
        caught = error;
      }

      expect(isUazapiClientError(caught)).toBe(true);
      expect(caught).toMatchObject({ kind: 'invalid_request' });
    }
  });

  it('refuses to build a client without a credential', () => {
    let caught: unknown;
    try {
      createUazapiAdminClient({
        baseUrl: BASE_URL,
        adminToken: '  ',
        fetch: vi.fn() as unknown as typeof fetch,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ kind: 'invalid_request' });
  });
});

describe('createUazapiInstanceClient', () => {
  it('sends the instance token and never the admin token', async () => {
    const fetchImpl = fetchReturning({ instance: { status: 'connected' } });

    await instanceClient(fetchImpl).getStatus();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/instance/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          token: INSTANCE_TOKEN,
          Accept: 'application/json',
        }),
      })
    );
    expect(lastInit(fetchImpl).headers).not.toHaveProperty('admintoken');
  });

  it('configures the webhook with the agreed subscription payload', async () => {
    const fetchImpl = fetchReturning([{ id: 'wh-1', enabled: true }]);

    await instanceClient(fetchImpl).configureWebhook({
      url: 'https://crm.example.com/api/whatsapp/webhook/uazapi/s3cr3t',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi', 'fromMeYes', 'isGroupYes'],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/webhook',
      expect.objectContaining({ method: 'POST' })
    );
    expect(lastBody(fetchImpl)).toEqual({
      enabled: true,
      url: 'https://crm.example.com/api/whatsapp/webhook/uazapi/s3cr3t',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi', 'fromMeYes', 'isGroupYes'],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    });
  });

  it('connects without a phone number so UAZAPI returns a QR code', async () => {
    const fetchImpl = fetchReturning({
      connected: false,
      loggedIn: false,
      instance: {
        id: 'i-1',
        status: 'connecting',
        qrcode: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      },
    });

    const instance = await instanceClient(fetchImpl).connect();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/instance/connect',
      expect.objectContaining({ method: 'POST' })
    );
    expect(lastBody(fetchImpl)).toEqual({});
    expect(instance.status).toBe('connecting');
    expect(instance.qrCodeDataUrl).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    );
  });

  it('reads connected identity from the documented status envelope', async () => {
    const fetchImpl = fetchReturning({
      instance: {
        id: 'i-1',
        name: 'wacrm-acc-1-a1b2',
        status: 'connected',
        profileName: 'Loja ABC',
        profilePicUrl: 'https://cdn.example.com/p.jpg',
      },
      status: {
        connected: true,
        loggedIn: true,
        jid: { user: '5511999999999', server: 's.whatsapp.net' },
      },
    });

    const instance = await instanceClient(fetchImpl).getStatus();

    expect(instance).toMatchObject({
      id: 'i-1',
      status: 'connected',
      connected: true,
      loggedIn: true,
      ownerPhone: '5511999999999',
      profileName: 'Loja ABC',
      profilePicUrl: 'https://cdn.example.com/p.jpg',
      qrCodeDataUrl: null,
    });
  });

  it('reports an unrecognized instance status as null instead of guessing', async () => {
    const fetchImpl = fetchReturning({ instance: { status: 'something_new' } });

    const instance = await instanceClient(fetchImpl).getStatus();

    expect(instance.status).toBeNull();
  });

  it('disconnects and deletes through the documented verbs', async () => {
    const disconnectFetch = fetchReturning({ response: 'Disconnected' });
    await instanceClient(disconnectFetch).disconnect();
    expect(disconnectFetch).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/instance/disconnect',
      expect.objectContaining({ method: 'POST' })
    );

    const deleteFetch = fetchReturning({ response: 'Instance Deleted' });
    await instanceClient(deleteFetch).deleteInstance();
    expect(deleteFetch).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/instance',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('accepts an empty body for an operation with no payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      instanceClient(fetchImpl).disconnect()
    ).resolves.toBeUndefined();
  });
});

describe('UAZAPI message sending', () => {
  it('maps a text send to the documented /send/text contract', async () => {
    const fetchImpl = fetchReturning({
      id: 'r1a2b3c',
      messageid: '3EB0538DA65A59F6D8A251',
      chatid: '5511999999999@s.whatsapp.net',
      status: 'Sent',
      messageTimestamp: 1758000000000,
    });

    const result = await instanceClient(fetchImpl).sendText({
      number: '5511999999999',
      text: 'Ola',
      replyId: '3EB0000000000000000000',
      trackSource: 'wacrm',
      trackId: 'local-uuid-1',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/send/text',
      expect.objectContaining({ method: 'POST' })
    );
    expect(lastBody(fetchImpl)).toEqual({
      number: '5511999999999',
      text: 'Ola',
      replyid: '3EB0000000000000000000',
      track_source: 'wacrm',
      track_id: 'local-uuid-1',
    });
    expect(result).toMatchObject({
      messageId: '3EB0538DA65A59F6D8A251',
      chatId: '5511999999999@s.whatsapp.net',
      status: 'Sent',
    });
  });

  it('maps media kinds, caption and document name', async () => {
    const fetchImpl = fetchReturning({ messageid: 'm-1' });

    await instanceClient(fetchImpl).sendMedia({
      number: '5511999999999',
      type: 'document',
      file: 'https://cdn.example.com/contrato.pdf',
      caption: 'Segue o documento',
      docName: 'Contrato.pdf',
      mimetype: 'application/pdf',
      trackSource: 'wacrm',
      trackId: 'local-uuid-2',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/send/media',
      expect.objectContaining({ method: 'POST' })
    );
    expect(lastBody(fetchImpl)).toEqual({
      number: '5511999999999',
      type: 'document',
      file: 'https://cdn.example.com/contrato.pdf',
      text: 'Segue o documento',
      docName: 'Contrato.pdf',
      mimetype: 'application/pdf',
      track_source: 'wacrm',
      track_id: 'local-uuid-2',
    });
  });

  it('falls back to the internal id when no provider id is returned', async () => {
    const fetchImpl = fetchReturning({ id: 'r1a2b3c' });

    const result = await instanceClient(fetchImpl).sendText({
      number: '5511999999999',
      text: 'Ola',
    });

    expect(result.messageId).toBe('r1a2b3c');
  });

  it('rejects a send response with no usable message id', async () => {
    const fetchImpl = fetchReturning({ response: { status: 'success' } });

    await expect(
      instanceClient(fetchImpl).sendText({ number: '5511', text: 'Ola' })
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('downloads inbound media as a link and never as base64', async () => {
    const fetchImpl = fetchReturning({
      fileURL: 'https://api.uazapi.com/files/a.jpg',
      mimetype: 'image/jpeg',
    });

    const media = await instanceClient(fetchImpl).downloadMessage('msg-1');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tenant.uazapi.com/message/download',
      expect.objectContaining({ method: 'POST' })
    );
    expect(lastBody(fetchImpl)).toEqual({
      id: 'msg-1',
      return_link: true,
      return_base64: false,
    });
    expect(media).toEqual({
      fileUrl: 'https://api.uazapi.com/files/a.jpg',
      mimeType: 'image/jpeg',
    });
  });
});

describe('UAZAPI history reads', () => {
  it('asks for one page of chats, newest activity first', async () => {
    const fetchImpl = fetchReturning({
      chats: [
        { wa_chatid: '5511999999999@s.whatsapp.net', wa_name: 'Ada' },
        { wa_chatid: '12345-67890@g.us', wa_isGroup: true, wa_name: 'Vendas' },
      ],
    });

    const page = await instanceClient(fetchImpl).findChats({
      limit: 50,
      offset: 0,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE_URL}/chat/find`);
    expect(lastBody(fetchImpl)).toMatchObject({
      limit: 50,
      offset: 0,
      sort: '-wa_lastMsgTimestamp',
    });
    expect(page.chats).toEqual([
      { id: '5511999999999@s.whatsapp.net', name: 'Ada', isGroup: false },
      { id: '12345-67890@g.us', name: 'Vendas', isGroup: true },
    ]);
  });

  it('reads a bare array of chats too, since the envelope varies', async () => {
    const fetchImpl = fetchReturning([{ id: '5511999999999@s.whatsapp.net' }]);

    const page = await instanceClient(fetchImpl).findChats({
      limit: 50,
      offset: 0,
    });

    expect(page.chats).toEqual([
      { id: '5511999999999@s.whatsapp.net', name: null, isGroup: false },
    ]);
  });

  it('skips a chat with no id rather than failing the whole page', async () => {
    const fetchImpl = fetchReturning({
      chats: [{ wa_name: 'nameless' }, { id: 'ok@s.whatsapp.net' }],
    });

    const page = await instanceClient(fetchImpl).findChats({
      limit: 50,
      offset: 0,
    });

    expect(page.chats).toHaveLength(1);
    expect(page.chats[0]?.id).toBe('ok@s.whatsapp.net');
  });

  it('asks for the newest messages of one chat', async () => {
    const fetchImpl = fetchReturning({
      messages: [{ messageid: 'm-1', text: 'oi' }],
    });

    const page = await instanceClient(fetchImpl).findMessages({
      chatId: '5511999999999@s.whatsapp.net',
      limit: 200,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE_URL}/message/find`);
    expect(lastBody(fetchImpl)).toMatchObject({
      chatid: '5511999999999@s.whatsapp.net',
      limit: 200,
      sort: '-messageTimestamp',
    });
    // Returned untouched: the normalizer, not the client, decides what a
    // message means, and it already reads this exact shape from webhooks.
    expect(page.messages).toEqual([{ messageid: 'm-1', text: 'oi' }]);
  });

  it('refuses to read messages without naming a chat', async () => {
    const fetchImpl = fetchReturning({ messages: [] });

    await expect(
      instanceClient(fetchImpl).findMessages({ chatId: '  ', limit: 10 })
    ).rejects.toSatisfy(isUazapiClientError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a missing list as an empty page, not as a broken response', async () => {
    const fetchImpl = fetchReturning({});

    const chats = await instanceClient(fetchImpl).findChats({
      limit: 10,
      offset: 0,
    });
    expect(chats.chats).toEqual([]);
  });
});

describe('UAZAPI transport safety', () => {
  it('aborts a slow request with a 15 second budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'i-1' }));

    await instanceClient(fetchImpl).getStatus();

    const signal = lastInit(fetchImpl).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('makes exactly one attempt and reports an ambiguous send timeout', async () => {
    const timeout = new DOMException(
      'The operation timed out.',
      'TimeoutError'
    );
    const fetchImpl = vi.fn().mockRejectedValue(timeout);

    const sending = instanceClient(fetchImpl).sendText({
      number: '5511999999999',
      text: 'Ola',
    });

    await expect(sending).rejects.toMatchObject({
      kind: 'upstream_unavailable',
      operation: 'send.text',
      ambiguous: true,
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one attempt when a send is rejected upstream', async () => {
    const fetchImpl = fetchReturning({ error: 'Rate limit exceeded' }, 429);

    await expect(
      instanceClient(fetchImpl).sendText({ number: '5511', text: 'Ola' })
    ).rejects.toMatchObject({ kind: 'rate_limited', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks an idempotent status read as safe to retry later', async () => {
    const fetchImpl = fetchReturning({ error: 'Internal server error' }, 500);

    await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject({
      kind: 'upstream_unavailable',
      operation: 'instance.status',
      retryable: true,
      ambiguous: false,
    });
  });

  it('maps documented failure statuses to typed errors', async () => {
    const cases = [
      { status: 401, kind: 'authentication' },
      { status: 404, kind: 'not_found' },
      { status: 409, kind: 'conflict' },
    ] as const;

    for (const { status, kind } of cases) {
      const fetchImpl = fetchReturning({ error: 'nope' }, status);
      await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject(
        {
          kind,
          httpStatus: status,
        }
      );
    }
  });

  it('never leaks the instance token through an upstream error body', async () => {
    const fetchImpl = fetchReturning(
      { error: 'Invalid token', token: INSTANCE_TOKEN },
      401
    );

    const error = await instanceClient(fetchImpl)
      .getStatus()
      .catch((caught: unknown) => caught);

    expect(isUazapiClientError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(INSTANCE_TOKEN);
    expect((error as Error).message).not.toContain(INSTANCE_TOKEN);
  });

  it('refuses a response body larger than 1 MiB', async () => {
    const oversized = JSON.stringify({ pad: 'a'.repeat(1_100_000) });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('refuses a response body that is not JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>502</html>', { status: 200 }));

    await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('refuses a JSON body that is not an object or array', async () => {
    const fetchImpl = fetchReturning('just a string');

    await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('reports a network failure as an unavailable upstream', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(instanceClient(fetchImpl).getStatus()).rejects.toMatchObject({
      kind: 'upstream_unavailable',
    });
  });
});

describe('normalizeUazapiQrCode', () => {
  it('accepts raw base64 and returns a PNG data URL', () => {
    expect(normalizeUazapiQrCode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    );
  });

  it('keeps an already normalized image data URL', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ';
    expect(normalizeUazapiQrCode(dataUrl)).toBe(dataUrl);
  });

  it('rejects anything that is not an image payload', () => {
    expect(normalizeUazapiQrCode('')).toBeNull();
    expect(normalizeUazapiQrCode(null)).toBeNull();
    expect(normalizeUazapiQrCode(undefined)).toBeNull();
    expect(normalizeUazapiQrCode(42)).toBeNull();
    expect(normalizeUazapiQrCode('data:text/html;base64,PGh0bWw+')).toBeNull();
    expect(normalizeUazapiQrCode('https://example.com/qr.png')).toBeNull();
  });

  it('rejects an oversized QR payload', () => {
    expect(normalizeUazapiQrCode('A'.repeat(600_000))).toBeNull();
  });
});
