import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uazapi = vi.hoisted(() => ({ sendText: vi.fn() }));
const meta = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
}));
const state = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  writes: { messages: [] as Record<string, unknown>[] },
}));

function fakeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') state.writes.messages.push(row);
          return builder;
        },
        update: () => builder,
        maybeSingle: async () => ({
          data:
            table === 'contacts'
              ? { id: 'ct-1', phone: '+55 11 99999-9999', wa_user_id: null }
              : table === 'whatsapp_config_secrets'
                ? { uazapi_instance_token: 'plain-instance-token' }
                : null,
          error: null,
        }),
        single: async () => ({
          data: table === 'whatsapp_config' ? state.config : null,
          error: state.config ? null : { message: 'missing' },
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return builder;
    },
  };
}

vi.mock('./admin-client', () => ({ supabaseAdmin: () => fakeDb() }));
vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: () => fakeDb(),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: meta.sendTextMessage,
  sendTemplateMessage: meta.sendTemplateMessage,
}));
vi.mock('@/lib/whatsapp/providers/uazapi-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createUazapiInstanceClient: () => ({
    sendText: uazapi.sendText,
    sendMedia: vi.fn(),
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
    downloadMessage: vi.fn(),
  }),
}));

import { engineSendTemplate, engineSendText } from './meta-send';

const META_CONFIG = {
  id: 'cfg-meta',
  provider: 'meta',
  status: 'connected',
  phone_number_id: 'pn-1',
  access_token: 'token',
};

const UAZAPI_CONFIG = {
  id: 'cfg-uaz',
  provider: 'uazapi',
  status: 'connected',
  phone_number_id: null,
  access_token: null,
};

const BASE = {
  accountId: 'acc-1',
  userId: 'user-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
};

beforeEach(() => {
  state.config = META_CONFIG;
  state.writes.messages = [];
  vi.stubEnv('UAZAPI_ENABLED', 'true');
  vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');

  meta.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  meta.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' });
  uazapi.sendText.mockResolvedValue({
    messageId: 'uaz-msg-1',
    chatId: null,
    status: 'Sent',
    timestamp: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('automations engineSendText', () => {
  it('sends an automation text through UAZAPI and stores the provider', async () => {
    state.config = UAZAPI_CONFIG;

    const result = await engineSendText({ ...BASE, text: 'ola' });

    expect(uazapi.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ number: '5511999999999', text: 'ola' })
    );
    expect(result).toEqual({ whatsapp_message_id: 'uaz-msg-1' });
    expect(state.writes.messages[0]).toMatchObject({
      provider: 'uazapi',
      message_id: 'uaz-msg-1',
      sender_type: 'bot',
      content_type: 'text',
    });
  });

  it('still sends through Meta for a Meta account', async () => {
    const result = await engineSendText({ ...BASE, text: 'hi' });

    expect(meta.sendTextMessage).toHaveBeenCalledOnce();
    expect(uazapi.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ whatsapp_message_id: 'wamid.text' });
    expect(state.writes.messages[0]).toMatchObject({ provider: 'meta' });
  });
});

describe('automations engineSendTemplate', () => {
  it('refuses a template automation under UAZAPI', async () => {
    state.config = UAZAPI_CONFIG;

    await expect(
      engineSendTemplate({ ...BASE, templateName: 'order_update' })
    ).rejects.toMatchObject({ code: 'provider_not_supported' });

    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
    expect(uazapi.sendText).not.toHaveBeenCalled();
    expect(state.writes.messages).toHaveLength(0);
  });

  it('still sends a template on Meta', async () => {
    const result = await engineSendTemplate({
      ...BASE,
      templateName: 'order_update',
      params: ['A123'],
    });

    expect(meta.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'order_update' })
    );
    expect(result).toEqual({ whatsapp_message_id: 'wamid.tpl' });
    expect(state.writes.messages[0]).toMatchObject({
      provider: 'meta',
      content_type: 'template',
    });
  });
});
