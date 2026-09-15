import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../encryption';
import type { MetaSendFunctions } from './meta-provider';
import {
  loadProviderTransport,
  sendProviderMessage,
} from './send-provider-message';

const INSTALLATION = {
  baseUrl: 'https://tenant.uazapi.com',
  adminToken: 'admin-secret',
  siteUrl: 'https://crm.example.com',
};

const META_CONFIG = {
  id: 'cfg-meta',
  provider: 'meta',
  status: 'connected',
  phone_number_id: 'phone-1',
  access_token: encrypt('meta-token'),
};

const UAZAPI_CONFIG = {
  id: 'cfg-uaz',
  provider: 'uazapi',
  status: 'connected',
  phone_number_id: null,
  access_token: null,
};

function dbWith(
  config: Record<string, unknown> | null,
  identities: unknown[] = []
) {
  return {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({
          data: config,
          error: config ? null : { message: 'not found' },
        }),
        then: (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
          resolve({
            data: table === 'whatsapp_contact_identities' ? identities : [],
            error: null,
          }),
      };
      return query;
    },
  };
}

function uazapiClient() {
  return {
    sendText: vi.fn().mockResolvedValue({
      messageId: 'uaz-1',
      chatId: null,
      status: 'Sent',
      timestamp: null,
    }),
    sendMedia: vi.fn().mockResolvedValue({
      messageId: 'uaz-2',
      chatId: null,
      status: 'Sent',
      timestamp: null,
    }),
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
    downloadMessage: vi.fn(),
  };
}

let metaFns: MetaSendFunctions & {
  sendText: ReturnType<typeof vi.fn>;
  sendMedia: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  metaFns = {
    sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.1' }),
    sendMedia: vi.fn().mockResolvedValue({ messageId: 'wamid.2' }),
  } as unknown as typeof metaFns;
});

describe('loadProviderTransport', () => {
  it('builds the Meta transport from the saved credentials', async () => {
    const loaded = await loadProviderTransport(dbWith(META_CONFIG), 'acc-1', {
      metaFns,
    });

    expect(loaded.provider).toBe('meta');
    expect(loaded.accessToken).toBe('meta-token');

    await loaded.transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      trackId: 'local-1',
    });
    expect(metaFns.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'phone-1',
        accessToken: 'meta-token',
      })
    );
  });

  it('builds the UAZAPI transport from the instance token', async () => {
    const client = uazapiClient();
    const createUazapiClient = vi.fn(() => client);

    const loaded = await loadProviderTransport(dbWith(UAZAPI_CONFIG), 'acc-1', {
      installation: INSTALLATION,
      loadInstanceToken: async () => 'plain-instance-token',
      createUazapiClient,
    });

    expect(loaded.provider).toBe('uazapi');
    expect(loaded.accessToken).toBeNull();
    expect(createUazapiClient).toHaveBeenCalledWith({
      baseUrl: 'https://tenant.uazapi.com',
      instanceToken: 'plain-instance-token',
    });

    await loaded.transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      trackId: 'local-1',
    });
    expect(client.sendText).toHaveBeenCalledOnce();
  });

  it('refuses to send when no configuration exists', async () => {
    await expect(
      loadProviderTransport(dbWith(null), 'acc-1', { metaFns })
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });

  it('refuses a UAZAPI send while the session is not connected', async () => {
    await expect(
      loadProviderTransport(
        dbWith({ ...UAZAPI_CONFIG, status: 'connecting' }),
        'acc-1',
        {
          installation: INSTALLATION,
          loadInstanceToken: async () => 'plain-instance-token',
          createUazapiClient: () => uazapiClient(),
        }
      )
    ).rejects.toMatchObject({ code: 'whatsapp_not_connected', status: 409 });
  });

  it('still sends on Meta when the row is not marked connected', async () => {
    // Meta rows can sit in 'disconnected' with working credentials — a
    // save whose /register step failed does exactly that — and those
    // accounts could always send. Nothing here may change that.
    const loaded = await loadProviderTransport(
      dbWith({ ...META_CONFIG, status: 'disconnected' }),
      'acc-1',
      { metaFns }
    );

    await expect(
      loaded.transport.send('5511999999999', {
        kind: 'text',
        text: 'Ola',
        trackId: 'local-1',
      })
    ).resolves.toMatchObject({ provider: 'meta' });
  });

  it('refuses a UAZAPI send when the installation is not configured', async () => {
    await expect(
      loadProviderTransport(dbWith(UAZAPI_CONFIG), 'acc-1', {
        installation: null,
        loadInstanceToken: async () => 'plain-instance-token',
      })
    ).rejects.toMatchObject({ code: 'uazapi_not_available' });
  });

  it('refuses a UAZAPI send when the instance token is missing', async () => {
    await expect(
      loadProviderTransport(dbWith(UAZAPI_CONFIG), 'acc-1', {
        installation: INSTALLATION,
        loadInstanceToken: async () => null,
      })
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured' });
  });
});

describe('sendProviderMessage', () => {
  it('resolves the recipient and sends once through the active provider', async () => {
    const client = uazapiClient();

    const result = await sendProviderMessage(
      dbWith(UAZAPI_CONFIG),
      'acc-1',
      { id: 'c-1', phone: '+55 11 99999-9999' },
      { kind: 'text', text: 'Ola', trackId: 'local-1' },
      {
        installation: INSTALLATION,
        loadInstanceToken: async () => 'plain-instance-token',
        createUazapiClient: () => client,
      }
    );

    expect(result).toEqual({
      provider: 'uazapi',
      externalMessageId: 'uaz-1',
      status: 'sent',
    });
    expect(client.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ number: '5511999999999' })
    );
  });

  it('sends through Meta for a Meta account without touching UAZAPI', async () => {
    const createUazapiClient = vi.fn();

    const result = await sendProviderMessage(
      dbWith(META_CONFIG),
      'acc-1',
      { id: 'c-1', phone: '+55 11 99999-9999' },
      { kind: 'text', text: 'Ola', trackId: 'local-1' },
      { metaFns, createUazapiClient }
    );

    expect(result.provider).toBe('meta');
    expect(result.externalMessageId).toBe('wamid.1');
    expect(createUazapiClient).not.toHaveBeenCalled();
  });

  it('fails before any transport call when the contact is unreachable', async () => {
    const client = uazapiClient();

    await expect(
      sendProviderMessage(
        dbWith(UAZAPI_CONFIG),
        'acc-1',
        { id: 'c-1', phone: null },
        { kind: 'text', text: 'Ola', trackId: 'local-1' },
        {
          installation: INSTALLATION,
          loadInstanceToken: async () => 'plain-instance-token',
          createUazapiClient: () => client,
        }
      )
    ).rejects.toMatchObject({ code: 'bad_request' });

    expect(client.sendText).not.toHaveBeenCalled();
  });
});
