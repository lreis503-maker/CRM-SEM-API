import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadAccountCapabilitySnapshot } from '@/lib/whatsapp/providers/account-capabilities';

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const snapshot = await loadAccountCapabilitySnapshot(
      supabase as unknown as Parameters<typeof loadAccountCapabilitySnapshot>[0],
      accountId,
      process.env
    );
    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
