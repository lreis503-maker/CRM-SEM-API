import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  getReminder,
  MonthlyPaymentNotFoundError,
} from '@/lib/monthly-payments/repository';
import { sendMonthlyPaymentMessage } from '@/lib/monthly-payments/runner';

type Params = { params: Promise<{ id: string }> };

function currentCompetence(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}-01`;
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const [{ id }, { accountId }] = await Promise.all([params, requireRole('admin')]);
    const db = supabaseAdmin();
    const reminder = await getReminder(db, accountId, id);
    const sent = await sendMonthlyPaymentMessage({
      db,
      reminder,
      competence: currentCompetence(new Date()),
      trackId: `monthly-payment-test:${id}:${Date.now()}`,
    });
    return NextResponse.json({ ok: true, provider_message_id: sent.providerMessageId ?? null });
  } catch (error) {
    if (error instanceof MonthlyPaymentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof Error && error.message) {
      return NextResponse.json({ error: error.message.slice(0, 200) }, { status: 502 });
    }
    return toErrorResponse(error);
  }
}

