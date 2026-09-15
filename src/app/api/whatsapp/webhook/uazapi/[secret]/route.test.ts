import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const mocks = vi.hoisted(() => ({
  processInboundMessage: vi.fn(),
  processStatusUpdate: vi.fn(),
  quarantineWebhookFailure: vi.fn(),
  purgeExpiredWebhookQuarantine: vi.fn(),
  createUazapiInstanceClient: vi.fn(() => ({ downloadMessage: vi.fn() })),
  config: null as Record<string, unknown> | null,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
}));

function fakeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          mocks.filters.push({ table, column, value });
          return builder;
        },
        update: (patch: Record<string, unknown>) => {
          mocks.updates.push({ table, patch });
          return builder;
        },
        maybeSingle: async () => ({
          data:
            table === 'whatsapp_config'
              ? mocks.config
              : table === 'whatsapp_config_secrets'
                ? { uazapi_instance_token: 'enc(instance-token)' }
                : null,
          error: null,
        }),
        then: (resolve: (r: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
}

vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: () => fakeDb(),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
}));
vi.mock('@/lib/whatsapp/inbound/process-inbound-message', () => ({
  processInboundMessage: mocks.processInboundMessage,
}));
vi.mock('@/lib/whatsapp/inbound/process-status-update', () => ({
  processStatusUpdate: mocks.processStatusUpdate,
}));
vi.mock('@/lib/whatsapp/inbound/webhook-quarantine', () => ({
  quarantineWebhookFailure: mocks.quarantineWebhookFailure,
  purgeExpiredWebhookQuarantine: mocks.purgeExpiredWebhookQuarantine,
}));
vi.mock('@/lib/whatsapp/providers/uazapi-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createUazapiInstanceClient: mocks.createUazapiInstanceClient,
}));

import { TransientInboundError } from '@/lib/whatsapp/inbound/types';

import { POST } from './route';

const SECRET = 'route-secret-value';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');

const CONFIG = {
  id: 'cfg-uaz',
  account_id: 'acc-1',
  user_id: 'user-1',
  provider: 'uazapi',
  status: 'connected',
  uazapi_instance_id: 'i-1',
  mirror_inbound_media: true,
};

const TEXT_EVENT = {
  event: 'messages',
  instance: 'i-1',
  data: {
    messageid: 'uaz-1',
    chatid: '5511999999999@s.whatsapp.net',
    sender_pn: '5511999999999@s.whatsapp.net',
    senderName: 'Ada',
    fromMe: false,
    isGroup: false,
    messageType: 'text',
    messageTimestamp: 1789000000000,
    text: 'oi',
  },
};

function request(body: unknown, raw?: string): Request {
  return new Request('https://crm.example.com/api/whatsapp/webhook/uazapi/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

function context(secret: string) {
  return { params: Promise.resolve({ secret }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = CONFIG;
  mocks.filters = [];
  mocks.updates = [];
  vi.stubEnv('UAZAPI_ENABLED', 'true');
  vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');
  mocks.processInboundMessage.mockResolvedValue(undefined);
  mocks.processStatusUpdate.mockResolvedValue(undefined);
  mocks.quarantineWebhookFailure.mockResolvedValue(undefined);
});

describe('UAZAPI webhook — authentication', () => {
  it('looks the account up by the hash of the route secret, never the secret', async () => {
    await POST(request(TEXT_EVENT), context(SECRET));

    expect(mocks.filters).toContainEqual({
      table: 'whatsapp_config',
      column: 'uazapi_webhook_secret_hash',
      value: SECRET_HASH,
    });
    expect(mocks.filters).toContainEqual({
      table: 'whatsapp_config',
      column: 'provider',
      value: 'uazapi',
    });
    expect(JSON.stringify(mocks.filters)).not.toContain(SECRET);
  });

  it('hides whether an unknown secret belongs to an account', async () => {
    mocks.config = null;

    const response = await POST(request(TEXT_EVENT), context('unknown'));

    expect(response.status).toBe(404);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
    expect(mocks.quarantineWebhookFailure).not.toHaveBeenCalled();
  });

  it('refuses a payload claiming a different instance', async () => {
    const response = await POST(
      request({ ...TEXT_EVENT, instance: 'someone-else' }),
      context(SECRET)
    );

    expect(response.status).toBe(404);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it('accepts a payload that names no instance at all', async () => {
    const { instance: _omit, ...withoutInstance } = TEXT_EVENT;
    void _omit;

    const response = await POST(request(withoutInstance), context(SECRET));

    expect(response.status).toBe(200);
    expect(mocks.processInboundMessage).toHaveBeenCalledOnce();
  });
});

describe('UAZAPI webhook — body limits', () => {
  it('refuses a body over 1 MiB before parsing it', async () => {
    const oversized = JSON.stringify({ pad: 'a'.repeat(1_200_000) });

    const response = await POST(request(null, oversized), context(SECRET));

    expect(response.status).toBe(413);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const response = await POST(request(null, 'not json'), context(SECRET));

    expect(response.status).toBe(400);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });
});

describe('UAZAPI webhook — recognized events', () => {
  it('processes a text message through the shared processor', async () => {
    const response = await POST(request(TEXT_EVENT), context(SECRET));

    expect(response.status).toBe(200);
    expect(mocks.processInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        configOwnerUserId: 'user-1',
        event: expect.objectContaining({
          provider: 'uazapi',
          externalMessageId: 'uaz-1',
        }),
      })
    );
  });

  it('processes a status update through the shared processor', async () => {
    const response = await POST(
      request({
        event: 'messages_update',
        instance: 'i-1',
        data: { messageid: 'uaz-1', status: 'Read', messageTimestamp: 1 },
      }),
      context(SECRET)
    );

    expect(response.status).toBe(200);
    expect(mocks.processStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ provider: 'uazapi', status: 'read' }),
      })
    );
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it('records a connection change on the configuration only', async () => {
    const response = await POST(
      request({
        event: 'connection',
        instance: 'i-1',
        data: {
          status: 'connected',
          profileName: 'Loja',
          profilePicUrl: 'https://x/y.jpg',
        },
      }),
      context(SECRET)
    );

    expect(response.status).toBe(200);
    expect(mocks.updates).toContainEqual({
      table: 'whatsapp_config',
      patch: expect.objectContaining({
        status: 'connected',
        connected_name: 'Loja',
        connected_avatar_url: 'https://x/y.jpg',
      }),
    });
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
    expect(mocks.processStatusUpdate).not.toHaveBeenCalled();
  });

  it('acknowledges an ignored message without storing anything', async () => {
    const response = await POST(
      request({ ...TEXT_EVENT, data: { ...TEXT_EVENT.data, fromMe: true } }),
      context(SECRET)
    );

    expect(response.status).toBe(200);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
    expect(mocks.quarantineWebhookFailure).not.toHaveBeenCalled();
  });
});

describe('UAZAPI webhook — payloads we cannot read', () => {
  it('acks and quarantines a valid-secret unknown payload', async () => {
    const response = await POST(
      request({ event: 'messages', instance: 'i-1', data: {} }),
      context(SECRET)
    );

    expect(response.status).toBe(200);
    expect(mocks.quarantineWebhookFailure).toHaveBeenCalledOnce();
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it('files the quarantine row against the account and configuration', async () => {
    await POST(
      request({ event: 'presence', instance: 'i-1', data: {} }),
      context(SECRET)
    );

    expect(mocks.quarantineWebhookFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        configId: 'cfg-uaz',
        provider: 'uazapi',
        reasonCode: 'unknown_event',
        eventName: 'presence',
      })
    );
  });

  it('expires old quarantine rows opportunistically', async () => {
    await POST(
      request({ event: 'presence', instance: 'i-1', data: {} }),
      context(SECRET)
    );

    expect(mocks.purgeExpiredWebhookQuarantine).toHaveBeenCalled();
  });
});

describe('UAZAPI webhook — failures', () => {
  it('returns 503 for a transient database failure so UAZAPI retries', async () => {
    mocks.processInboundMessage.mockRejectedValue(
      new TransientInboundError('db')
    );

    const response = await POST(request(TEXT_EVENT), context(SECRET));

    expect(response.status).toBe(503);
  });

  it('returns 503 for an unexpected failure rather than losing the message', async () => {
    mocks.processInboundMessage.mockRejectedValue(new Error('boom'));

    const response = await POST(request(TEXT_EVENT), context(SECRET));

    expect(response.status).toBe(503);
  });

  it('never returns a credential in any response', async () => {
    mocks.config = null;
    const response = await POST(request(TEXT_EVENT), context(SECRET));
    const body = await response.text();

    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('instance-token');
    expect(body).not.toContain('admin-secret');
  });
});
