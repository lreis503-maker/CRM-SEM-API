import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startAds: vi.fn(() => false),
  startMonthly: vi.fn(() => false),
}));

vi.mock('@/lib/ads/scheduler', () => ({ startAdMonitorScheduler: mocks.startAds }));
vi.mock('@/lib/monthly-payments/scheduler', () => ({
  startMonthlyPaymentScheduler: mocks.startMonthly,
}));

import { register } from './instrumentation';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('server instrumentation', () => {
  it('starts both account-level schedulers in the Node server runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', 'phase-production-server');

    await register();

    expect(mocks.startAds).toHaveBeenCalledOnce();
    expect(mocks.startMonthly).toHaveBeenCalledOnce();
  });
});

