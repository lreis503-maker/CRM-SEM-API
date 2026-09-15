import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/whatsapp/admin-client';
import { resolveUazapiInstallation } from '@/lib/whatsapp/providers/account-capabilities';
import {
  beginUazapiConnection,
  createUazapiConnectionContext,
  regenerateUazapiQrCode,
  uazapiConnectionErrorResponse,
} from '@/lib/whatsapp/providers/uazapi-instance';

const ACTIONS = ['start', 'refresh_qr'] as const;
type ConnectAction = (typeof ACTIONS)[number];

function readAction(body: unknown): ConnectAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const action = (body as { action?: unknown }).action;
  return ACTIONS.includes(action as ConnectAction)
    ? (action as ConnectAction)
    : null;
}

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Starts pairing (`start`) or re-issues a QR code on the instance the
 * account already owns (`refresh_qr`). Both change provider credentials,
 * so both require an account admin.
 *
 * The response carries only `UazapiConnectionView` plus the counts of work
 * the switch stopped. No token, secret or instance identifier is included.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    const installation = resolveUazapiInstallation(process.env);
    if (!installation) {
      // Deliberately unspecific: which variable is missing is an operator
      // detail, not something to publish to a browser.
      return NextResponse.json(
        { error: 'uazapi_not_available' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => null);
    const action = readAction(body);
    if (action === null) {
      return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
    }

    const context = createUazapiConnectionContext({
      db: supabaseAdmin(),
      accountId,
      userId,
      installation,
    });

    if (action === 'refresh_qr') {
      const connection = await regenerateUazapiQrCode(context);
      return NextResponse.json({ connection, affected: null });
    }

    const result = await beginUazapiConnection(context);
    return NextResponse.json({
      connection: result.publicView,
      affected: result.affected,
    });
  } catch (error) {
    return uazapiConnectionErrorResponse(error) ?? toErrorResponse(error);
  }
}
