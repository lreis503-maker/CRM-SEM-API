import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  getSubscribedApps: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token-de-teste' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  getSubscribedApps: mocks.getSubscribedApps,
}));

import { GET } from './route';

describe('diagnóstico do recebimento de webhooks', () => {
  beforeEach(() => {
    vi.stubEnv('META_APP_SECRET', 'segredo-real-de-teste');
    vi.stubEnv('META_APP_ID', '123456');
    mocks.verifyPhoneNumber.mockResolvedValue({ id: '111' });
    mocks.getSubscribedApps.mockResolvedValue([{ whatsapp_business_api_data: { id: '123456' } }]);
    mocks.createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: 'usuario' } }, error: null }) },
      from: (table: string) => ({
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: table === 'profiles'
          ? { account_id: 'conta' }
          : { phone_number_id: '111', waba_id: '222', access_token: 'criptografado', registered_at: '2026-09-14T00:00:00Z' } }),
      }),
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('não indica recebimento ativo quando o segredo é o valor de exemplo', async () => {
    vi.stubEnv('META_APP_SECRET', 'your-meta-app-secret');
    const result = await (await GET()).json();
    expect(result.live).toBe(false);
    expect(result.checks.phone_metadata_ok).toBe(true);
    expect(result.checks.webhook_secret_configured).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('META_APP_SECRET')]));
  });

  it('indica recebimento ativo quando o segredo e a inscrição estão configurados', async () => {
    const result = await (await GET()).json();
    expect(result.live).toBe(true);
    expect(result.checks.webhook_secret_configured).toBe(true);
    expect(result.checks.waba_subscribed_to_app).toBe(true);
  });

  it('não considera a inscrição em outro aplicativo como sucesso', async () => {
    mocks.getSubscribedApps.mockResolvedValue([{ whatsapp_business_api_data: { id: '654321' } }]);
    const result = await (await GET()).json();
    expect(result.live).toBe(false);
    expect(result.checks.waba_subscribed_to_app).toBe(false);
  });
});
