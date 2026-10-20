import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  MonthlyPaymentNotFoundError,
  MonthlyPaymentRepositoryError,
  setReminderEnabled,
  softDeleteReminder,
  updateReminder,
} from '@/lib/monthly-payments/repository';
import { parseReminderInput, ReminderValidationError } from '@/lib/monthly-payments/validate';

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const [{ id }, { accountId, userId }] = await Promise.all([params, requireRole('admin')]);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ReminderValidationError('JSON inválido');

    const onlyToggle = Object.keys(body).every((key) => key === 'enabled');
    const reminder = onlyToggle && typeof body.enabled === 'boolean'
      ? await setReminderEnabled(supabaseAdmin(), accountId, id, body.enabled)
      : await updateReminder(
          supabaseAdmin(),
          { accountId, userId },
          id,
          parseReminderInput(body),
        );
    return NextResponse.json({ reminder });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const [{ id }, { accountId }] = await Promise.all([params, requireRole('admin')]);
    await softDeleteReminder(supabaseAdmin(), accountId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown): NextResponse {
  if (error instanceof MonthlyPaymentNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ReminderValidationError || error instanceof MonthlyPaymentRepositoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return toErrorResponse(error);
}

