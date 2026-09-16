import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(() => ({ name: 'service-role-client' })),
  createContext: vi.fn(() => ({ name: 'ctx' })),
  refresh: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 401 })
  ),
}));

vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/whatsapp/providers/uazapi-instance', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/whatsapp/providers/uazapi-instance')
    >();
  return {
    ...actual,
    createUazapiConnectionContext: mocks.createContext,
    refreshUazapiConnection: mocks.refresh,
  };
});

import { UazapiConnectionError } from '@/lib/whatsapp/providers/uazapi-instance';

import { GET } from './route';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';

const CONNECTED_VIEW = {
  provider: 'uazapi' as const,
  status: 'connected' as const,
  attemptId: ATTEMPT,
  qrCodeDataUrl: null,
  qrExpiresAt: null,
  connectedPhone: '5511999999999',
  connectedName: 'Loja ABC',
  connectedAvatarUrl: 'https://cdn.example.com/p.jpg',
  error: null,
};

function request(query = ''): Request {
  return new Request(
    `https://crm.example.com/api/whatsapp/uazapi/status${query}`
  );
}

beforeEach(() => {
  vi.stubEnv('UAZAPI_ENABLED', 'true');
  vi.stubEnv('UAZAPI_BASE_URL', 'https://tenant.uazapi.com');
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');

  mocks.requireRole.mockResolvedValue({
    supabase: { name: 'account-scoped-client' },
    accountId: 'acc-1',
    userId: 'user-1',
  });
  mocks.refresh.mockResolvedValue(CONNECTED_VIEW);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/whatsapp/uazapi/status', () => {
  it('lets any account member read the connection state', async () => {
    const response = await GET(request(`?attempt=${ATTEMPT}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(mocks.refresh).toHaveBeenCalledWith(
      { name: 'ctx' },
      { attemptId: ATTEMPT }
    );
    expect(body).toEqual({ connection: CONNECTED_VIEW });
    expect(JSON.stringify(body)).not.toContain('admin-secret');
  });

  it('reads the current state when no attempt is pinned', async () => {
    await GET(request());

    expect(mocks.refresh).toHaveBeenCalledWith({ name: 'ctx' }, {});
  });

  it('ignores an attempt parameter that is not a uuid', async () => {
    await GET(request('?attempt=not-a-uuid'));

    expect(mocks.refresh).toHaveBeenCalledWith({ name: 'ctx' }, {});
  });

  it('answers 404 for an account with no UAZAPI configuration', async () => {
    mocks.refresh.mockRejectedValue(
      new UazapiConnectionError('not_configured', 404)
    );

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });

  it('reports an unconfigured installation as unavailable', async () => {
    vi.stubEnv('UAZAPI_BASE_URL', 'http://insecure.example.com');

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'uazapi_not_available' });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
