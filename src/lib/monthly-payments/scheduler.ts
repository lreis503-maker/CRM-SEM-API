import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { runMonthlyPaymentDeliveries } from './runner';

const FIRST_TICK_DELAY_MS = 30_000;
const TICK_INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;

let started = false;

function schedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MONTHLY_PAYMENTS_AUTORUN === 'false') return false;
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function acquireMonthlyPaymentSchedulerLease(
  db: SupabaseClient,
  holder: string,
  now: Date = new Date(),
  leaseMs = LEASE_MS,
): Promise<boolean> {
  const { data, error } = await db
    .from('monthly_payment_scheduler_lease')
    .update({
      locked_until: new Date(now.getTime() + leaseMs).toISOString(),
      holder,
      updated_at: now.toISOString(),
    })
    .eq('id', true)
    .lt('locked_until', now.toISOString())
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function tick(holder: string): Promise<void> {
  const db = supabaseAdmin();
  const now = new Date();
  if (!(await acquireMonthlyPaymentSchedulerLease(db, holder, now))) return;
  await runMonthlyPaymentDeliveries(db, { now, holder, limit: 100 });
}

export function startMonthlyPaymentScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (started || !schedulerEnabled(env)) return false;
  started = true;
  const holder = `${process.pid}@${new Date().toISOString()}`;
  const run = () => {
    void tick(holder).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[monthly-payments-scheduler] ciclo falhou:', message.slice(0, 500));
    });
  };
  setTimeout(run, FIRST_TICK_DELAY_MS).unref?.();
  setInterval(run, TICK_INTERVAL_MS).unref?.();
  return true;
}

export function resetMonthlyPaymentSchedulerForTests(): void {
  started = false;
}

