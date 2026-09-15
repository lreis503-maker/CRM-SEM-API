import { NextResponse } from 'next/server';

import { loadAccountCapabilitySnapshot } from './account-capabilities';
import {
  assertProviderCapability,
  ProviderNotSupportedError,
} from './capabilities';
import type { WhatsAppCapability } from './types';

type AccountCapabilityReader = Parameters<
  typeof loadAccountCapabilitySnapshot
>[0];

/**
 * Resolves provider capabilities for an authenticated account before an
 * operation reads provider credentials or causes an external side effect.
 */
export async function requireAccountCapability(
  db: unknown,
  accountId: string,
  capability: WhatsAppCapability
): Promise<void> {
  const snapshot = await loadAccountCapabilitySnapshot(
    db as AccountCapabilityReader,
    accountId,
    process.env
  );
  assertProviderCapability(snapshot.provider, capability);
}

export function providerCapabilityErrorResponse(
  error: ProviderNotSupportedError
): NextResponse {
  return NextResponse.json(
    {
      error: 'provider_not_supported',
      provider: error.provider,
      capability: error.capability,
    },
    { status: 409 }
  );
}

export function isProviderNotSupportedError(
  error: unknown
): error is ProviderNotSupportedError {
  return error instanceof ProviderNotSupportedError;
}
