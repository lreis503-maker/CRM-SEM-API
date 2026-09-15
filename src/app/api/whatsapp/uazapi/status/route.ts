import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/whatsapp/admin-client';
import { resolveUazapiInstallation } from '@/lib/whatsapp/providers/account-capabilities';
import {
  createUazapiConnectionContext,
  refreshUazapiConnection,
  uazapiConnectionErrorResponse,
} from '@/lib/whatsapp/providers/uazapi-instance';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/whatsapp/uazapi/status?attempt=<uuid>
 *
 * Authoritative connection state, polled by Settings while a QR code is on
 * screen. Reading the state is not a credential operation, so any account
 * member may call it.
 *
 * `attempt` pins the answer to one pairing attempt: a poller left over from
 * an expired QR gets the current stored state back instead of overwriting
 * the attempt that replaced it.
 */
export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('viewer');

    const installation = resolveUazapiInstallation(process.env);
    if (!installation) {
      return NextResponse.json(
        { error: 'uazapi_not_available' },
        { status: 503 }
      );
    }

    const attempt = new URL(request.url).searchParams.get('attempt');
    const context = createUazapiConnectionContext({
      db: supabaseAdmin(),
      accountId,
      userId,
      installation,
    });

    const connection = await refreshUazapiConnection(
      context,
      attempt !== null && UUID_PATTERN.test(attempt)
        ? { attemptId: attempt }
        : {}
    );

    return NextResponse.json({ connection });
  } catch (error) {
    return uazapiConnectionErrorResponse(error) ?? toErrorResponse(error);
  }
}
