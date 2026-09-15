import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  importUazapiHistoryBatch: vi.fn(),
  processInboundMessage: vi.fn(),
  createUazapiInstanceClient: vi.fn(() => ({
    findChats: vi.fn(),
    findMessages: vi.fn(),
  })),
  config: null as Record<string, unknown> | null,
  run: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  insertFails: false,
}));

function fakeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (row: Record<string, unknown>) => {
          mocks.inserted.push({ table, ...row });
          return builder;
        },
        update: (patch: Record<string, unknown>) => {
          mocks.updated.push({ table, ...patch });
          return builder;
        },
        single: async () =>
          mocks.insertFails
            ? { data: null, error: { code: '23505' } }
            : { data: { ...mocks.run, id: 'run-1' }, error: null },
        maybeSingle: async () => ({
          data:
            table === 'whatsapp_config'
              ? mocks.config
              : table === 'whatsapp_config_secrets'
                ? { uazapi_instance_token: 'enc(instance-token)' }
                : table === 'whatsapp_history_imports'
                  ? mocks.run
                  : null,
          error: null,
        }),
      };
      return builder;
    },
  };
}

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/whatsapp/admin-client', () => ({ supabaseAdmin: fakeDb }));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
}));
vi.mock('@/lib/whatsapp/history/import-uazapi-history', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  importUazapiHistoryBatch: mocks.importUazapiHistoryBatch,
}));
vi.mock('@/lib/whatsapp/inbound/process-inbound-message', () => ({
  processInboundMessage: mocks.processInboundMessage,
}));
vi.mock('@/lib/whatsapp/providers/uazapi-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createUazapiInstanceClient: mocks.createUazapiInstanceClient,
}));

import { GET, POST } from './route';

const CONFIG = {
  id: 'cfg-uaz',
  account_id: 'acc-1',
  user_id: 'user-1',
  provider: 'uazapi',
  status: 'connected',
  uazapi_instance_id: 'i-1',
  mirror_inbound_media: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ accountId: 'acc-1', userId: 'user-1' });
  mocks.config = CONFIG;
  mocks.run = {
    id: 'run-1',
    status: 'running',
    chat_offset: 0,
    message_offset: 0,
    chats_seen: 0,
    messages_imported: 0,
  };
  mocks.inserted = [];
  mocks.updated = [];
  mocks.insertFails = false;
  mocks.importUazapiHistoryBatch.mockResolvedValue({
    chatsSeen: 3,
    messagesImported: 12,
    skippedMessages: 0,
    failedChats: 0,
    nextChatOffset: 3,
    nextMessageOffset: 0,
    done: false,
  });
  vi.stubEnv('UAZAPI_ENABLED', 'true');
  vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');
});

describe('POST /api/whatsapp/uazapi/import-history — access', () => {
  it('is an admin action, since it writes into every conversation', async () => {
    await POST();

    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('refuses when the account is not on UAZAPI', async () => {
    mocks.config = { ...CONFIG, provider: 'meta' };

    const response = await POST();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'provider_not_supported',
    });
    expect(mocks.importUazapiHistoryBatch).not.toHaveBeenCalled();
  });

  it('refuses a second run started in the same instant', async () => {
    // Two clicks racing. The partial unique index refuses the second
    // insert, and this call has nothing to add to the one already going.
    mocks.run = null;
    mocks.insertFails = true;

    const response = await POST();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'import_already_running',
    });
    expect(mocks.importUazapiHistoryBatch).not.toHaveBeenCalled();
  });

  it('refuses while the number is not connected', async () => {
    mocks.config = { ...CONFIG, status: 'pending' };

    const response = await POST();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'not_connected' });
  });
});

describe('POST /api/whatsapp/uazapi/import-history — progress', () => {
  it('resumes from the cursor the last batch left behind', async () => {
    mocks.run = { ...mocks.run, chat_offset: 24, message_offset: 600 };

    await POST();

    // Both halves. Without the message offset a batch stopped inside a
    // long thread would restart that thread from its newest message and
    // never reach the older half.
    expect(mocks.importUazapiHistoryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ chatOffset: 24, messageOffset: 600 })
    );
  });

  it('stores how deep into the current chat it got', async () => {
    mocks.importUazapiHistoryBatch.mockResolvedValue({
      chatsSeen: 0,
      messagesImported: 500,
      skippedMessages: 0,
      failedChats: 0,
      nextChatOffset: 3,
      nextMessageOffset: 1000,
      done: false,
    });

    await POST();

    expect(mocks.updated).toContainEqual(
      expect.objectContaining({
        table: 'whatsapp_history_imports',
        chat_offset: 3,
        message_offset: 1000,
      })
    );
  });

  it('stores what the batch found and where it stopped', async () => {
    mocks.run = {
      ...mocks.run,
      chat_offset: 3,
      chats_seen: 3,
      messages_imported: 12,
    };
    mocks.importUazapiHistoryBatch.mockResolvedValue({
      chatsSeen: 3,
      messagesImported: 12,
      skippedMessages: 0,
      failedChats: 0,
      // Absolute: where the next batch starts. The counters accumulate,
      // the cursor does not.
      nextChatOffset: 6,
      nextMessageOffset: 0,
      done: false,
    });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(mocks.updated).toContainEqual(
      expect.objectContaining({
        table: 'whatsapp_history_imports',
        chat_offset: 6,
        chats_seen: 6,
        messages_imported: 24,
        status: 'running',
      })
    );
    expect(await response.json()).toMatchObject({ done: false });
  });

  it('closes the run when the walk reaches the end', async () => {
    mocks.importUazapiHistoryBatch.mockResolvedValue({
      chatsSeen: 1,
      messagesImported: 2,
      skippedMessages: 0,
      failedChats: 0,
      nextChatOffset: 1,
      nextMessageOffset: 0,
      done: true,
    });

    const response = await POST();

    expect(mocks.updated).toContainEqual(
      expect.objectContaining({
        table: 'whatsapp_history_imports',
        status: 'completed',
      })
    );
    expect(await response.json()).toMatchObject({ done: true });
  });

  it('marks the run failed when the provider goes down mid-walk', async () => {
    mocks.importUazapiHistoryBatch.mockRejectedValue(new Error('upstream'));

    const response = await POST();

    expect(response.status).toBe(502);
    expect(mocks.updated).toContainEqual(
      expect.objectContaining({
        table: 'whatsapp_history_imports',
        status: 'failed',
        error_code: 'provider_unavailable',
      })
    );
  });

  it('never returns an upstream message or a credential', async () => {
    mocks.importUazapiHistoryBatch.mockRejectedValue(
      new Error('token enc(instance-token) rejected by tenant')
    );

    const body = await (await POST()).text();

    expect(body).not.toContain('instance-token');
    expect(body).not.toContain('rejected by tenant');
  });
});

describe('POST /api/whatsapp/uazapi/import-history — storing', () => {
  it('files every message as imported, so nothing reacts to it', async () => {
    mocks.importUazapiHistoryBatch.mockImplementation(
      async (input: {
        store: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        await input.store({ kind: 'message', externalMessageId: 'm-1' });
        return {
          chatsSeen: 1,
          messagesImported: 1,
          skippedMessages: 0,
          failedChats: 0,
          nextChatOffset: 1,
          nextMessageOffset: 0,
          done: true,
        };
      }
    );

    await POST();

    expect(mocks.processInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        configOwnerUserId: 'user-1',
        imported: true,
      })
    );
  });
});

describe('GET /api/whatsapp/uazapi/import-history', () => {
  it('reports the run without exposing anything but progress', async () => {
    mocks.run = {
      id: 'run-1',
      status: 'running',
      chat_offset: 8,
      chats_seen: 8,
      messages_imported: 40,
      error_code: null,
      started_at: '2026-09-15T00:00:00.000Z',
      finished_at: null,
    };

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.import).toEqual({
      status: 'running',
      chatsSeen: 8,
      messagesImported: 40,
      errorCode: null,
      startedAt: '2026-09-15T00:00:00.000Z',
      finishedAt: null,
    });
  });

  it('says so plainly when no import has ever run', async () => {
    mocks.run = null;

    const body = await (await GET()).json();

    expect(body).toEqual({ import: null });
  });

  it('is readable by any member, since progress is not a credential', async () => {
    await GET();

    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
  });
});
