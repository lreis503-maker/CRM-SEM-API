import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  supabaseAdmin: vi.fn(() => ({ name: 'service-role-client' })),
  verifyPhoneNumber: vi.fn(),
  listWabaPhoneNumbers: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  getSubscribedApps: vi.fn(),
  createContext: vi.fn(() => ({ name: 'ctx' })),
  disconnectUazapi: vi.fn(),
  removeUazapi: vi.fn(),
  order: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createAdminClient,
}));
vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (value: string) => `enc(${value})`,
  decrypt: (value: string) => value.replace(/^enc\(|\)$/g, ''),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  listWabaPhoneNumbers: mocks.listWabaPhoneNumbers,
  registerPhoneNumber: mocks.registerPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
  getSubscribedApps: mocks.getSubscribedApps,
}));
vi.mock('@/lib/whatsapp/providers/uazapi-instance', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/whatsapp/providers/uazapi-instance')
    >();
  return {
    ...actual,
    createUazapiConnectionContext: mocks.createContext,
    disconnectUazapiInstance: mocks.disconnectUazapi,
    removeUazapiConnection: mocks.removeUazapi,
  };
});

import { DELETE, GET, POST } from './route';

interface Writes {
  updates: Record<string, unknown>[];
  inserts: Record<string, unknown>[];
  deletes: number;
}

function makeSupabase(config: Record<string, unknown> | null) {
  const writes: Writes = { updates: [], inserts: [], deletes: 0 };

  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        update(row: Record<string, unknown>) {
          writes.updates.push(row);
          return query;
        },
        insert(row: Record<string, unknown>) {
          writes.inserts.push(row);
          return query;
        },
        delete() {
          writes.deletes += 1;
          mocks.order.push('local_delete');
          return query;
        },
        maybeSingle: async () => ({
          data: table === 'profiles' ? { account_id: 'acc-1' } : config,
          error: null,
        }),
        then: (resolve: (value: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return query;
    },
  };

  return { supabase, writes };
}

const META_CONFIG = {
  id: 'cfg-meta',
  provider: 'meta',
  status: 'connected',
  phone_number_id: '111',
  waba_id: '222',
  access_token: 'enc(meta-token)',
  registered_at: '2026-09-14T00:00:00.000Z',
};

const UAZAPI_CONFIG = {
  id: 'cfg-uaz',
  provider: 'uazapi',
  status: 'connected',
  phone_number_id: null,
  waba_id: null,
  access_token: null,
  registered_at: null,
  connection_attempt_id: '11111111-1111-4111-8111-111111111111',
  connected_phone: '5511999999999',
  connected_name: 'Loja ABC',
  connected_avatar_url: 'https://cdn.example.com/p.jpg',
  last_connection_error: null,
};

function useConfig(config: Record<string, unknown> | null) {
  const { supabase, writes } = makeSupabase(config);
  mocks.createClient.mockResolvedValue(supabase);
  return writes;
}

beforeEach(() => {
  mocks.order.length = 0;
  vi.stubEnv('UAZAPI_ENABLED', 'true');
  vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');

  mocks.createAdminClient.mockReturnValue({
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      neq() {
        return this;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    }),
  });
  mocks.verifyPhoneNumber.mockResolvedValue({ id: '111' });
  mocks.listWabaPhoneNumbers.mockResolvedValue([{ id: '111' }]);
  mocks.registerPhoneNumber.mockImplementation(async () => {
    mocks.order.push('meta_register');
  });
  mocks.subscribeWabaToApp.mockResolvedValue(undefined);
  mocks.getSubscribedApps.mockResolvedValue([]);
  mocks.disconnectUazapi.mockImplementation(async () => {
    mocks.order.push('uazapi_disconnect');
  });
  mocks.removeUazapi.mockImplementation(async () => {
    mocks.order.push('uazapi_remove');
  });
});

describe('GET /api/whatsapp/config', () => {
  it('reports UAZAPI state without ever calling Meta', async () => {
    useConfig(UAZAPI_CONFIG);

    const body = await (await GET()).json();

    expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled();
    expect(body.provider).toBe('uazapi');
    expect(body.connected).toBe(true);
    expect(body.connection).toMatchObject({
      provider: 'uazapi',
      status: 'connected',
      connectedPhone: '5511999999999',
      connectedName: 'Loja ABC',
      qrCodeDataUrl: null,
    });
    expect(JSON.stringify(body)).not.toContain('admin-secret');
  });

  it('keeps the existing Meta diagnostics untouched', async () => {
    useConfig(META_CONFIG);

    const body = await (await GET()).json();

    expect(mocks.verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: '111',
      accessToken: 'meta-token',
    });
    expect(body).toMatchObject({
      connected: true,
      provider: 'meta',
      phone_info: { id: '111' },
    });
  });
});

describe('DELETE /api/whatsapp/config', () => {
  it('removes the remote UAZAPI instance instead of only the local row', async () => {
    const writes = useConfig(UAZAPI_CONFIG);

    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(mocks.removeUazapi).toHaveBeenCalledOnce();
    expect(writes.deletes).toBe(0);
  });

  it('keeps the plain local delete for a Meta account', async () => {
    const writes = useConfig(META_CONFIG);

    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(mocks.removeUazapi).not.toHaveBeenCalled();
    expect(writes.deletes).toBe(1);
  });
});

function metaRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://crm.example.com/api/whatsapp/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone_number_id: '111',
      waba_id: '222',
      access_token: 'meta-token',
      pin: '123456',
      ...body,
    }),
  });
}

describe('POST /api/whatsapp/config switching from UAZAPI', () => {
  it('disconnects UAZAPI before Meta registers and deletes it only after', async () => {
    const writes = useConfig(UAZAPI_CONFIG);

    const response = await POST(metaRequest());
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mocks.order).toEqual([
      'uazapi_disconnect',
      'meta_register',
      'uazapi_remove',
    ]);
    expect(writes.inserts).toHaveLength(1);
    expect(writes.inserts[0]).toMatchObject({
      account_id: 'acc-1',
      phone_number_id: '111',
    });
  });

  it('keeps the recoverable UAZAPI row when Meta registration fails', async () => {
    const writes = useConfig(UAZAPI_CONFIG);
    mocks.registerPhoneNumber.mockRejectedValue(new Error('PIN incorreto'));

    const response = await POST(metaRequest());

    expect(response.status).toBe(400);
    expect(mocks.removeUazapi).not.toHaveBeenCalled();
    expect(writes.inserts).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });

  it('never starts the switch when the Meta credentials are rejected', async () => {
    useConfig(UAZAPI_CONFIG);
    mocks.verifyPhoneNumber.mockRejectedValue(new Error('Invalid token'));

    await POST(metaRequest());

    expect(mocks.disconnectUazapi).not.toHaveBeenCalled();
    expect(mocks.removeUazapi).not.toHaveBeenCalled();
  });

  it('leaves a Meta-to-Meta save on the existing update path', async () => {
    const writes = useConfig(META_CONFIG);

    await POST(metaRequest());

    expect(mocks.disconnectUazapi).not.toHaveBeenCalled();
    expect(mocks.removeUazapi).not.toHaveBeenCalled();
    expect(writes.updates).toHaveLength(1);
    expect(writes.inserts).toHaveLength(0);
  });
});
