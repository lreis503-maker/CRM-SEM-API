import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  listDeliveries,
  MonthlyPaymentNotFoundError,
} from '@/lib/monthly-payments/repository';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const [{ id }, { accountId }] = await Promise.all([params, requireRole('admin')]);
    const deliveries = await listDeliveries(supabaseAdmin(), accountId, id);
    return NextResponse.json({ deliveries });
  } catch (error) {
    if (error instanceof MonthlyPaymentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return toErrorResponse(error);
  }
}

