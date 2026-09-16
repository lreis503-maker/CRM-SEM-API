import { describe, expect, it } from 'vitest';

import { loadAccountCapabilitySnapshot } from './account-capabilities';

type ConfigRow = { provider: string; status: string } | null;

function dbWithConfig(config: ConfigRow) {
  const query = {
    eq: () => query,
    maybeSingle: async () => ({ data: config, error: null }),
  };

  return {
    from: () => ({
      select: () => query,
    }),
  };
}

describe('loadAccountCapabilitySnapshot', () => {
  it('defaults an account without configuration to Meta product behavior', async () => {
    const result = await loadAccountCapabilitySnapshot(
      dbWithConfig(null),
      'acc-1',
      {}
    );

    expect(result.provider).toBe('meta');
    expect(result.status).toBe('not_configured');
    expect(result.connected).toBe(false);
    expect(result.capabilities.templates).toBe(true);
    expect(result.uazapiAvailable).toBe(false);
  });

  it('returns UAZAPI restrictions and installation availability', async () => {
    const result = await loadAccountCapabilitySnapshot(
      dbWithConfig({ provider: 'uazapi', status: 'connected' }),
      'acc-1',
      {
        UAZAPI_ENABLED: 'true',
        UAZAPI_BASE_URL: 'https://tenant.uazapi.com',
        UAZAPI_ADMIN_TOKEN: 'secret',
        NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
      }
    );

    expect(result.connected).toBe(true);
    expect(result.capabilities.broadcasts).toBe(false);
    expect(result.uazapiAvailable).toBe(true);
  });

  it.each([
    'http://tenant.uazapi.com',
    'https://tenant.uazapi.com/v1',
    'https://user:password@tenant.uazapi.com',
  ])('rejects an unsafe UAZAPI base URL: %s', async (baseUrl) => {
    const result = await loadAccountCapabilitySnapshot(
      dbWithConfig({ provider: 'uazapi', status: 'connected' }),
      'acc-1',
      {
        UAZAPI_ENABLED: 'true',
        UAZAPI_BASE_URL: baseUrl,
        UAZAPI_ADMIN_TOKEN: 'secret',
        NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
      }
    );

    expect(result.uazapiAvailable).toBe(false);
  });

  it('selects only provider and status for the current account', async () => {
    const selects: string[] = [];
    const accountIds: string[] = [];
    const query = {
      eq: (_column: string, accountId: string) => {
        accountIds.push(accountId);
        return query;
      },
      maybeSingle: async () => ({
        data: { provider: 'meta', status: 'connected' },
        error: null,
      }),
    };
    const db = {
      from: () => ({
        select: (columns: string) => {
          selects.push(columns);
          return query;
        },
      }),
    };

    await loadAccountCapabilitySnapshot(db, 'acc-1', {});

    expect(selects).toEqual(['provider, status']);
    expect(accountIds).toEqual(['acc-1']);
  });
});
