import crypto from 'node:crypto';

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { runMonthlyPaymentDeliveries } from '@/lib/monthly-payments/runner';

export const maxDuration = 60;

function secretMatches(expected: string, authorization: string | null): boolean {
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) return false;
  const given = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

export async function POST(request: Request) {
  const secret = process.env.MONTHLY_PAYMENTS_CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'Cron de mensalidades não configurado' }, { status: 503 });
  }
  if (!secretMatches(secret, request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }
  try {
    const result = await runMonthlyPaymentDeliveries(supabaseAdmin(), {
      holder: `external@${new Date().toISOString()}`,
      limit: 500,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[monthly-payments-cron] execução falhou:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Falha ao executar mensalidades' }, { status: 500 });
  }
}

