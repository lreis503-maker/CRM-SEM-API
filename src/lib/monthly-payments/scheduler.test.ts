import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireMonthlyPaymentSchedulerLease,
  resetMonthlyPaymentSchedulerForTests,
  startMonthlyPaymentScheduler,
} from './scheduler';

function leaseDb(won: boolean) {
  const filters: Array<[string, string, unknown]> = [];
  let updated: Record<string, unknown> | null = null;
  const query = {
    update(payload: Record<string, unknown>) {
      updated = payload;
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push(['eq', column, value]);
      return query;
    },
    lt(column: string, value: unknown) {
      filters.push(['lt', column, value]);
      return query;
    },
    async select() {
      return { data: won ? [{ id: true }] : [], error: null };
    },
  };
  return {
    db: { from: () => query } as unknown as SupabaseClient,
    filters,
    updated: () => updated,
  };
}

const ENV = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
} as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetMonthlyPaymentSchedulerForTests();
});

describe('acquireMonthlyPaymentSchedulerLease', () => {
  it('keeps the expiry condition inside the update', async () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    const { db, filters, updated } = leaseDb(true);

    await expect(
      acquireMonthlyPaymentSchedulerLease(db, 'instance-a', now, 2 * 60_000),
    ).resolves.toBe(true);
    expect(filters).toContainEqual(['eq', 'id', true]);
    expect(filters).toContainEqual(['lt', 'locked_until', now.toISOString()]);
    expect(updated()).toMatchObject({
      holder: 'instance-a',
      locked_until: '2026-10-20T12:02:00.000Z',
    });
  });

  it('loses when another instance holds the lease', async () => {
    const { db } = leaseDb(false);
    await expect(acquireMonthlyPaymentSchedulerLease(db, 'instance-b')).resolves.toBe(false);
  });
});

describe('startMonthlyPaymentScheduler', () => {
  it('starts once with a one-minute interval and delayed first tick', () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(global, 'setTimeout');
    const interval = vi.spyOn(global, 'setInterval');

    expect(startMonthlyPaymentScheduler(ENV)).toBe(true);
    expect(startMonthlyPaymentScheduler(ENV)).toBe(false);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it('stays off when explicitly disabled or credentials are missing', () => {
    expect(startMonthlyPaymentScheduler({ ...ENV, MONTHLY_PAYMENTS_AUTORUN: 'false' })).toBe(false);
    resetMonthlyPaymentSchedulerForTests();
    expect(startMonthlyPaymentScheduler({
      NODE_ENV: 'test',
      NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL,
    } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
