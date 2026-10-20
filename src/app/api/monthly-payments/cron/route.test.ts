import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/monthly-payments/runner', () => ({
  runMonthlyPaymentDeliveries: mocks.run,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONTHLY_PAYMENTS_CRON_SECRET = 'cron-secret';
  mocks.run.mockResolvedValue({ claimed: 1, sent: 1, failed: 0 });
});

describe('monthly payment cron route', () => {
  it('rejects a missing or wrong bearer secret', async () => {
    expect((await POST(new Request('http://localhost', { method: 'POST' }))).status).toBe(401);
    expect(
      (await POST(new Request('http://localhost', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      }))).status,
    ).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('returns a configuration error when the secret is absent', async () => {
    delete process.env.MONTHLY_PAYMENTS_CRON_SECRET;
    expect((await POST(new Request('http://localhost', { method: 'POST' }))).status).toBe(503);
  });

  it('runs the batch for a valid bearer secret', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { authorization: 'Bearer cron-secret' },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ claimed: 1, sent: 1, failed: 0 });
  });
});

