import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  acquireSchedulerLease,
  resetSchedulerForTests,
  startAdMonitorScheduler,
} from './scheduler';

/**
 * Banco de mentira focado na trava: registra os filtros do UPDATE para
 * o teste poder afirmar que a condição de prazo viajou junto, e
 * devolve linha ou vazio conforme a disputa foi ganha ou perdida.
 */
function leaseDb(won: boolean) {
  const filters: Array<[string, string, unknown]> = [];
  let updated: Record<string, unknown> | null = null;

  const query = {
    update: (payload: Record<string, unknown>) => {
      updated = payload;
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.push(['eq', column, value]);
      return query;
    },
    lt: (column: string, value: unknown) => {
      filters.push(['lt', column, value]);
      return query;
    },
    select: async () => ({ data: won ? [{ id: true }] : [], error: null }),
  };

  const db = { from: () => query } as unknown as SupabaseClient;
  return { db, filters, updated: () => updated };
}

const NOW = new Date('2026-09-22T12:00:00.000Z');

describe('acquireSchedulerLease', () => {
  it('assume a trava quando ela está vencida', async () => {
    const { db, filters, updated } = leaseDb(true);

    await expect(
      acquireSchedulerLease(db, 'instancia-a', NOW, 20 * 60_000)
    ).resolves.toBe(true);

    // A condição de prazo tem que viajar no próprio UPDATE. Ler antes
    // e escrever depois abriria a janela para as duas instâncias
    // acharem que ganharam.
    expect(filters).toContainEqual(['lt', 'locked_until', NOW.toISOString()]);
    expect(filters).toContainEqual(['eq', 'id', true]);

    expect(updated()).toMatchObject({
      locked_until: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      holder: 'instancia-a',
    });
  });

  it('desiste quando outra instância já segurou', async () => {
    const { db } = leaseDb(false);

    await expect(
      acquireSchedulerLease(db, 'instancia-b', NOW)
    ).resolves.toBe(false);
  });
});

describe('startAdMonitorScheduler', () => {
  const ENV = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://projeto.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico',
  } as unknown as NodeJS.ProcessEnv;

  it('liga o laço com as credenciais presentes', () => {
    resetSchedulerForTests();
    vi.useFakeTimers();
    expect(startAdMonitorScheduler(ENV)).toBe(true);
    vi.useRealTimers();
  });

  it('não liga duas vezes no mesmo processo', () => {
    resetSchedulerForTests();
    vi.useFakeTimers();
    expect(startAdMonitorScheduler(ENV)).toBe(true);
    expect(startAdMonitorScheduler(ENV)).toBe(false);
    vi.useRealTimers();
  });

  it('respeita o desligamento explícito', () => {
    resetSchedulerForTests();
    expect(
      startAdMonitorScheduler({
        ...ENV,
        ADS_MONITOR_AUTORUN: 'false',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('não sobe o laço sem credencial de service role', () => {
    resetSchedulerForTests();
    expect(
      startAdMonitorScheduler({
        NEXT_PUBLIC_SUPABASE_URL: 'https://projeto.supabase.co',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});
