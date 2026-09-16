import type {
  UazapiInstallation,
  WhatsAppCapabilitySnapshot,
  WhatsAppConnectionStatus,
  WhatsAppProvider,
} from './types';

import { PROVIDER_CAPABILITIES } from './capabilities';

type WhatsAppConfigRow = {
  provider: string | null;
  status: string | null;
};

type WhatsAppConfigReader = {
  from: (table: 'whatsapp_config') => {
    select: (columns: 'provider, status') => {
      eq: (
        column: 'account_id',
        accountId: string
      ) => {
        maybeSingle: () => PromiseLike<{
          data: WhatsAppConfigRow | null;
          error: unknown;
        }>;
      };
    };
  };
};

type UazapiEnvironment = Readonly<Record<string, string | undefined>>;

const CONNECTION_STATUSES: readonly WhatsAppConnectionStatus[] = [
  'not_configured',
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
  'error',
];

function isConnectionStatus(
  value: string | null
): value is WhatsAppConnectionStatus {
  return (
    value !== null && (CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSafeUazapiBaseUrl(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.pathname === '/' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function hasValidSiteUrl(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The single place that decides whether this installation can talk to
 * UAZAPI at all. Returns the validated settings for server-side callers,
 * or null when the operator has not finished configuring them.
 *
 * `loadAccountCapabilitySnapshot` only reports whether this is non-null,
 * so the browser learns availability without learning any value.
 */
export function resolveUazapiInstallation(
  env: UazapiEnvironment
): UazapiInstallation | null {
  if (env.UAZAPI_ENABLED !== 'true') return null;
  if (!hasSafeUazapiBaseUrl(env.UAZAPI_BASE_URL)) return null;
  if (!hasValue(env.UAZAPI_ADMIN_TOKEN)) return null;
  if (!hasValidSiteUrl(env.NEXT_PUBLIC_SITE_URL)) return null;

  return {
    baseUrl: new URL(env.UAZAPI_BASE_URL as string).origin,
    adminToken: (env.UAZAPI_ADMIN_TOKEN as string).trim(),
    siteUrl: new URL(env.NEXT_PUBLIC_SITE_URL as string).origin,
  };
}

function isUazapiAvailable(env: UazapiEnvironment): boolean {
  return resolveUazapiInstallation(env) !== null;
}

/**
 * Reads the account's public provider state without touching provider
 * credentials. The resulting snapshot is safe to return to the dashboard.
 */
export async function loadAccountCapabilitySnapshot(
  db: WhatsAppConfigReader,
  accountId: string,
  env: UazapiEnvironment
): Promise<WhatsAppCapabilitySnapshot> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('provider, status')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw error;

  const provider: WhatsAppProvider =
    data?.provider === 'uazapi' ? 'uazapi' : 'meta';
  const storedStatus = data?.status ?? null;
  const status: WhatsAppConnectionStatus = isConnectionStatus(storedStatus)
    ? storedStatus
    : 'not_configured';

  return {
    provider,
    status,
    connected: status === 'connected',
    uazapiAvailable: isUazapiAvailable(env),
    capabilities: PROVIDER_CAPABILITIES[provider],
  };
}
