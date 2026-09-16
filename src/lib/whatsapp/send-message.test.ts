import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Tipo de mensagem não compatível/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /conteúdo de texto é obrigatório/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /nome do modelo é obrigatório/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /URL da mídia é obrigatória/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /limite de 1024 caracteres/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /conteúdo da mensagem interativa é obrigatório/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /no máximo 3 botões/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /limite de 20 caracteres/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

// The encrypted UAZAPI instance token is read with the service role.
vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: async () => ({
        data: { uazapi_instance_token: 'plain-instance-token' },
        error: null,
      }),
    }),
  }),
}));

const uazapiSendText = vi.fn(async () => ({
  messageId: 'uaz-msg-1',
  chatId: null,
  status: 'Sent',
  timestamp: null,
}));
const uazapiSendMedia = vi.fn(async () => ({
  messageId: 'uaz-media-1',
  chatId: null,
  status: 'Sent',
  timestamp: null,
}));

vi.mock('@/lib/whatsapp/providers/uazapi-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createUazapiInstanceClient: () => ({
    sendText: uazapiSendText,
    sendMedia: uazapiSendMedia,
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
    downloadMessage: vi.fn(),
  }),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  contact: Record<string, unknown> = { id: 'ct-1', phone: '+15551234567' },
  configOverride: Record<string, unknown> | null = null
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact,
  };
  const config = configOverride ?? {
    id: 'cfg-1',
    provider: 'meta',
    status: 'connected',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta withholds the phone number for a customer who has adopted a
// WhatsApp username, so their contact row carries only `wa_user_id`.
// The send path used to reject those outright with "Contact phone
// number not found" — the business could receive their messages but
// never answer them.
// ============================================================

const BSUID = 'US.13491208655302741918';

describe('sendMessageToConversation — BSUID recipients (#519)', () => {
  it('sends to the BSUID when the contact has no phone number', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', wa_user_id: BSUID }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('still prefers the phone number when the contact has both', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: '+15551234567',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    // Only the phone path supports the trunk-prefix variant retry, so
    // it wins whenever we have a usable number.
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });

  it('falls back to the BSUID when the stored phone is unusable', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: 'not-a-number',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('400s when the contact has neither a usable phone nor a BSUID', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/não tem telefone nem ID de usuário do WhatsApp/);
  });

  it('ignores a wa_user_id that is not BSUID-shaped', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, {
          id: 'ct-1',
          phone: '',
          wa_user_id: 'garbage',
        }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/não tem telefone nem ID de usuário do WhatsApp/);
  });
});

// ============================================================
// Provider routing
//
// Text and media go through whichever provider the account has active.
// Everything Meta-only stays Meta-only, refused before any transport.
// ============================================================

const UAZAPI_CONFIG = {
  id: 'cfg-uaz',
  provider: 'uazapi',
  status: 'connected',
  phone_number_id: null,
  waba_id: null,
  access_token: null,
};

function uazapiDb(captured: CapturedWrites, contact?: Record<string, unknown>) {
  return sendPathDb([], captured, contact, UAZAPI_CONFIG);
}

describe('sendMessageToConversation - provider routing', () => {
  beforeEach(() => {
    vi.stubEnv('UAZAPI_ENABLED', 'true');
    vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');
    uazapiSendText.mockClear();
    uazapiSendMedia.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends text through UAZAPI and records the provider on the row', async () => {
    const captured: CapturedWrites = {};

    const result = await sendMessageToConversation(uazapiDb(captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'ola',
    });

    expect(uazapiSendText).toHaveBeenCalledWith(
      expect.objectContaining({ number: '15551234567', text: 'ola' })
    );
    expect(result.whatsappMessageId).toBe('uaz-msg-1');
    expect(captured.message).toMatchObject({
      provider: 'uazapi',
      message_id: 'uaz-msg-1',
      sender_type: 'agent',
    });
  });

  it('tracks the send with the id it persists', async () => {
    const captured: CapturedWrites = {};

    await sendMessageToConversation(uazapiDb(captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'ola',
    });

    // The row id is generated before the send so it can travel as the
    // tracking id. (The fake returns a fixed id from `.single()`, so the
    // assertion is against the row we actually wrote.)
    const [call] = uazapiSendText.mock.calls[0] as unknown as [
      { trackId: string },
    ];
    expect(typeof captured.message?.id).toBe('string');
    expect(call.trackId).toBe(captured.message?.id);
  });

  it('sends media through UAZAPI with the caption', async () => {
    const captured: CapturedWrites = {};

    await sendMessageToConversation(uazapiDb(captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'image',
      mediaUrl: 'https://cdn.example.com/a.jpg',
      contentText: 'veja',
    });

    expect(uazapiSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image', caption: 'veja' })
    );
    expect(captured.message?.provider).toBe('uazapi');
  });

  it('refuses a template under UAZAPI before any transport call', async () => {
    const captured: CapturedWrites = {};

    await expect(
      sendMessageToConversation(uazapiDb(captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
      })
    ).rejects.toMatchObject({ code: 'provider_not_supported', status: 409 });

    expect(uazapiSendText).not.toHaveBeenCalled();
    expect(uazapiSendMedia).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('refuses an interactive message under UAZAPI', async () => {
    const captured: CapturedWrites = {};

    await expect(
      sendMessageToConversation(uazapiDb(captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Escolha',
          buttons: [{ id: 'a', title: 'A' }],
        },
      })
    ).rejects.toMatchObject({ code: 'provider_not_supported' });
    expect(captured.message).toBeUndefined();
  });

  it('refuses to send while the UAZAPI session is not connected', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured, undefined, {
      ...UAZAPI_CONFIG,
      status: 'connecting',
    });

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'ola',
      })
    ).rejects.toMatchObject({ code: 'whatsapp_not_connected', status: 409 });
    expect(uazapiSendText).not.toHaveBeenCalled();
  });

  it('makes exactly one UAZAPI attempt when the send fails', async () => {
    const captured: CapturedWrites = {};
    uazapiSendText.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      sendMessageToConversation(uazapiDb(captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'ola',
      })
    ).rejects.toMatchObject({ code: 'provider_error', status: 502 });

    expect(uazapiSendText).toHaveBeenCalledTimes(1);
    expect(captured.message).toBeUndefined();
  });

  it('still records provider meta for a Meta account', async () => {
    const captured: CapturedWrites = {};

    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    });

    expect(captured.message?.provider).toBe('meta');
    expect(uazapiSendText).not.toHaveBeenCalled();
  });
});
