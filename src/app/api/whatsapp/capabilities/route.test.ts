import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAccountCapabilitySnapshot: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 401 })
  ),
}));

vi.mock('@/lib/whatsapp/providers/account-capabilities', () => ({
  loadAccountCapabilitySnapshot: mocks.loadAccountCapabilitySnapshot,
}));

import { GET } from './route';

const snapshot = {
  provider: 'uazapi' as const,
  status: 'connected' as const,
  connected: true,
  uazapiAvailable: true,
  capabilities: {
    connection_status: true,
    send_text: true,
    send_media: true,
    receive_text_media: true,
    meta_service_window: false,
    templates: false,
    template_sync: false,
    broadcasts: false,
    interactive: false,
    reactions: false,
    location: false,
  },
};

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.loadAccountCapabilitySnapshot.mockReset();
  mocks.requireRole.mockResolvedValue({
    supabase: { name: 'account-scoped-client' },
    accountId: 'acc-1',
  });
  mocks.loadAccountCapabilitySnapshot.mockResolvedValue(snapshot);
});

describe('GET /api/whatsapp/capabilities', () => {
  it('returns the authenticated account snapshot without credentials', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(mocks.loadAccountCapabilitySnapshot).toHaveBeenCalledWith(
      { name: 'account-scoped-client' },
      'acc-1',
      process.env
    );
    expect(body).toEqual(snapshot);
    expect(JSON.stringify(body)).not.toContain('UAZAPI_ADMIN_TOKEN');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
