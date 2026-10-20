import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  createReminder,
  listRecipientContacts,
  listReminders,
  MonthlyPaymentRepositoryError,
} from '@/lib/monthly-payments/repository';
import { parseReminderInput, ReminderValidationError } from '@/lib/monthly-payments/validate';

export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    const db = supabaseAdmin();
    const [reminders, contacts, whatsapp] = await Promise.all([
      listReminders(db, accountId),
      listRecipientContacts(db, accountId),
      db.from('whatsapp_config').select('provider').eq('account_id', accountId).maybeSingle(),
    ]);
    return NextResponse.json({
      reminders,
      contacts,
      whatsapp_provider: (whatsapp.data as { provider?: string } | null)?.provider ?? null,
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const input = parseReminderInput(body);
    const reminder = await createReminder(
      supabaseAdmin(),
      { accountId, userId },
      input,
    );
    return NextResponse.json({ reminder }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown): NextResponse {
  if (error instanceof ReminderValidationError || error instanceof MonthlyPaymentRepositoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return toErrorResponse(error);
}
