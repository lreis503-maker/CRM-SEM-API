import { describe, expect, it } from 'vitest';

import {
  providerCapabilityErrorResponse,
  requireAccountCapability,
} from './account-capability-guard';

function dbWithProvider(provider: 'meta' | 'uazapi') {
  const query = {
    eq: () => query,
    maybeSingle: async () => ({
      data: { provider, status: 'connected' },
      error: null,
    }),
  };

  return {
    from: () => ({
      select: () => query,
    }),
  };
}

describe('requireAccountCapability', () => {
  it('rejects a UAZAPI operation with the stable provider contract', async () => {
    await expect(
      requireAccountCapability(dbWithProvider('uazapi'), 'acc-1', 'templates')
    ).rejects.toMatchObject({
      code: 'provider_not_supported',
      provider: 'uazapi',
      capability: 'templates',
      status: 409,
    });
  });

  it('keeps Meta operations available', async () => {
    await expect(
      requireAccountCapability(dbWithProvider('meta'), 'acc-1', 'templates')
    ).resolves.toBeUndefined();
  });

  it('serializes unsupported provider errors without implementation details', async () => {
    const error = await requireAccountCapability(
      dbWithProvider('uazapi'),
      'acc-1',
      'broadcasts'
    ).catch((reason) => reason);

    const response = providerCapabilityErrorResponse(error);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'provider_not_supported',
      provider: 'uazapi',
      capability: 'broadcasts',
    });
  });
});
