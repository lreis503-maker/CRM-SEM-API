import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(() => ({ name: 'service-role-client' })),
  createContext: vi.fn(() => ({ name: 'ctx' })),
  begin: vi.fn(),
  regenerate: vi.fn(),
  resync: vi.fn(),
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
    beginUazapiConnection: mocks.begin,
    regenerateUazapiQrCode: mocks.regenerate,
    resyncUazapiWebhook: mocks.resync,
  };
});

import { UazapiConnectionError } from '@/lib/whatsapp/providers/uazapi-instance';
import { UazapiClientError } from '@/lib/whatsapp/providers/uazapi-errors';

import { POST } from './route';

const CONNECTION_VIEW = {
  provider: 'uazapi' as const,
  status: 'connecting' as const,
  attemptId: '11111111-1111-4111-8111-111111111111',
  qrCodeDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  qrExpiresAt: '2026-09-15T12:02:00.000Z',
  connectedPhone: null,
  connectedName: null,
  connectedAvatarUrl: null,
  error: null,
};

const AFFECTED = {
  cancelledBroadcasts: 2,
  deactivatedAutomations: 1,
  draftedFlows: 0,
  stoppedFlowRuns: 0,
};

function request(body: unknown): Request {
  return new Request('https://crm.example.com/api/whatsapp/uazapi/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  mocks.begin.mockResolvedValue({
    publicView: CONNECTION_VIEW,
    affected: AFFECTED,
  });
  mocks.regenerate.mockResolvedValue(CONNECTION_VIEW);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/whatsapp/uazapi/connect', () => {
  it('starts a connection for an account admin and reports the stopped work', async () => {
    const response = await POST(request({ action: 'start' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.createContext).toHaveBeenCalledWith({
      db: { name: 'service-role-client' },
      accountId: 'acc-1',
      userId: 'user-1',
      installation: {
        baseUrl: 'https://tenant.uazapi.com',
        adminToken: 'admin-secret',
        siteUrl: 'https://crm.example.com',
      },
    });
    expect(body).toEqual({ connection: CONNECTION_VIEW, affected: AFFECTED });
  });

  it('never returns a credential to the browser', async () => {
    const response = await POST(request({ action: 'start' }));
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain('admin-secret');
    expect(raw).not.toContain('instanceToken');
    expect(raw).not.toContain('webhook');
  });

  it('issues a new QR on the same instance for refresh_qr', async () => {
    const response = await POST(request({ action: 'refresh_qr' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.regenerate).toHaveBeenCalledOnce();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(body).toEqual({ connection: CONNECTION_VIEW, affected: null });
  });

  it('re-registers the webhook for resync_webhook, leaving the session alone', async () => {
    const response = await POST(request({ action: 'resync_webhook' }));

    expect(response.status).toBe(200);
    expect(mocks.resync).toHaveBeenCalledOnce();
    // The point of the action: no new instance, no new QR, nothing the
    // user has to go and scan.
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('answers a resync with no connection view to overwrite the panel', async () => {
    const body = await (
      await POST(request({ action: 'resync_webhook' }))
    ).json();

    // Re-registering checked nothing about the pairing, so the panel
    // keeps the state it already polled rather than being told a guess.
    expect(body).toEqual({ resynced: true });
  });

  it('never returns the rotated route secret', async () => {
    const raw = JSON.stringify(
      await (await POST(request({ action: 'resync_webhook' }))).json()
    );

    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('webhook');
  });

  it('rejects an unknown action before touching the provider', async () => {
    const response = await POST(request({ action: 'delete_everything' }));

    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const malformed = new Request(
      'https://crm.example.com/api/whatsapp/uazapi/connect',
      { method: 'POST', body: 'not json' }
    );

    expect((await POST(malformed)).status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it('reports an unconfigured installation without naming a variable', async () => {
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', '');

    const response = await POST(request({ action: 'start' }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'uazapi_not_available' });
    expect(JSON.stringify(body)).not.toContain('UAZAPI_');
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it('maps a provider mismatch to the stable 409 contract', async () => {
    mocks.begin.mockRejectedValue(new UazapiConnectionError('wrong_provider'));

    const response = await POST(request({ action: 'start' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'wrong_provider' });
  });

  it('maps an upstream failure to a reason code, not an upstream message', async () => {
    mocks.begin.mockRejectedValue(
      new UazapiClientError({
        operation: 'instance.create',
        kind: 'authentication',
        httpStatus: 401,
        details: { error: 'Invalid AdminToken Header', token: 'admin-secret' },
      })
    );

    const response = await POST(request({ action: 'start' }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'uazapi_request_failed',
      reason: 'authentication',
    });
    expect(JSON.stringify(body)).not.toContain('admin-secret');
    expect(JSON.stringify(body)).not.toContain('AdminToken');
  });
});
