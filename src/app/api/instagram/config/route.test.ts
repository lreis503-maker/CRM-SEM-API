import { describe, expect, it, vi, beforeEach } from 'vitest';

const requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: (...args: unknown[]) => requireRoleMock(...args) };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ neq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    }),
  }),
}));

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

import { POST } from './route';

function thenable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result);
  return builder;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'ig-1' }) }));
  requireRoleMock.mockResolvedValue({
    supabase: { from: () => thenable({ data: null, error: null }) },
    accountId: 'acc-1',
    userId: 'user-1',
  });
});

describe('POST /api/instagram/config', () => {
  it('rejects a request missing required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects when the Graph API cannot verify the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'bad token' } }) }),
    );
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({ page_id: 'p1', ig_user_id: 'ig1', page_access_token: 'tok' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('saves the config when verification succeeds', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({ page_id: 'p1', ig_user_id: 'ig1', page_access_token: 'tok' }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
