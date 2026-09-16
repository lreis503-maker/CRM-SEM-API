/**
 * UAZAPI instance lifecycle: create, pair by QR, inspect, and remove.
 *
 * The service is written against injected ports rather than a Supabase
 * client so every compensation path can be exercised. Two invariants hold
 * everywhere below:
 *
 * - the browser never receives the instance token, the webhook secret or
 *   the installation admin token â€” only the public `UazapiConnectionView`;
 * - the QR code is never written to the database or a log. It is read from
 *   UAZAPI, normalized, handed to the authenticated session, and dropped.
 *
 * Ordering is deliberate. Meta stays untouched until the remote instance
 * exists and its webhook is registered; if either step fails the remote
 * instance is deleted again and the account keeps working on Meta.
 */

import crypto from 'crypto';

import { NextResponse } from 'next/server';

import { decrypt, encrypt } from '../encryption';
import type {
  UazapiInstallation,
  WhatsAppConnectionStatus,
  WhatsAppProvider,
} from './types';
import {
  createUazapiAdminClient,
  createUazapiInstanceClient,
  type UazapiAdminClient,
  type UazapiInstance,
  type UazapiInstanceClient,
} from './uazapi-client';
import { isUazapiClientError } from './uazapi-errors';
import {
  switchAccountToUazapi,
  type ProviderSwitchCounts,
  type ProviderSwitchResult,
} from './provider-switch';

/** UAZAPI documents a two minute QR window before the code expires. */
export const UAZAPI_QR_TTL_SECONDS = 120;

const WEBHOOK_EVENTS = ['messages', 'messages_update', 'connection'] as const;

/**
 * Only messages this CRM itself sent are filtered out. They are already
 * stored at send time, and letting an automation see its own output is
 * how a bot ends up answering itself forever.
 *
 * Group traffic and messages typed on the linked phone DO arrive: a
 * salesperson needs to see the whole thread, including what a colleague
 * replied from their handset. The processor decides what each one means.
 */
const WEBHOOK_EXCLUDED_MESSAGES = ['wasSentByApi'] as const;

/** The public connection state. Contains no credential of any kind. */
export interface UazapiConnectionView {
  provider: 'uazapi';
  status: WhatsAppConnectionStatus;
  attemptId: string;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  connectedAvatarUrl: string | null;
  /** Stable machine-readable reason, never an upstream message. */
  error: string | null;
}

export interface StoredWhatsAppConfig {
  id: string;
  provider: WhatsAppProvider | string;
  status: string | null;
  uazapi_instance_id?: string | null;
  uazapi_instance_name?: string | null;
  uazapi_webhook_secret_hash?: string | null;
  connection_attempt_id?: string | null;
  connected_phone?: string | null;
  connected_name?: string | null;
  connected_avatar_url?: string | null;
  last_connection_error?: string | null;
}

/** The row handed to the transactional switch. Token already encrypted. */
export interface UazapiReplaceConfigInput {
  account_id: string;
  user_id: string;
  uazapi_instance_id: string;
  uazapi_instance_name: string;
  uazapi_instance_token: string;
  uazapi_webhook_secret_hash: string;
  connection_attempt_id: string;
}

export interface UazapiConfigPatch {
  status?: WhatsAppConnectionStatus;
  connection_attempt_id?: string;
  /** Rotated whenever the webhook is re-registered. Hash only. */
  uazapi_webhook_secret_hash?: string;
  connected_phone?: string | null;
  connected_name?: string | null;
  connected_avatar_url?: string | null;
  last_connection_error?: string | null;
  connection_checked_at?: string;
}

export interface UazapiConnectionContext {
  accountId: string;
  userId: string;
  /** Canonical origin the webhook callback is built from. */
  siteUrl: string;
  admin: UazapiAdminClient;
  instanceClientFor(instanceToken: string): UazapiInstanceClient;
  loadConfig(): Promise<StoredWhatsAppConfig | null>;
  /** Returns the decrypted instance token, or null when there is none. */
  loadInstanceToken(configId: string): Promise<string | null>;
  replaceConfig(input: UazapiReplaceConfigInput): Promise<ProviderSwitchResult>;
  updateConfig(configId: string, patch: UazapiConfigPatch): Promise<void>;
  deleteConfig(configId: string): Promise<void>;
  now?(): Date;
  generateWebhookSecret?(): string;
  generateAttemptId?(): string;
  generateInstanceSuffix?(): string;
}

export interface BeginUazapiConnectionResult {
  publicView: UazapiConnectionView;
  /** What the switch stopped, or null when an instance was resumed. */
  affected: ProviderSwitchCounts | null;
}

export type UazapiConnectionErrorCode =
  | 'not_configured'
  | 'wrong_provider'
  | 'missing_instance'
  | 'missing_token'
  | 'installation_unavailable';

export class UazapiConnectionError extends Error {
  readonly status: number;

  constructor(
    readonly code: UazapiConnectionErrorCode,
    status = 409
  ) {
    super(`UAZAPI connection error: ${code}`);
    this.name = 'UazapiConnectionError';
    this.status = status;
  }
}

/**
 * Maps a connection failure onto the wire. Returns null for anything this
 * module did not raise so the caller can fall back to its own handling.
 *
 * An upstream failure answers a stable reason code, never UAZAPI's own
 * message: that text can echo a token or a URL back at us.
 */
export function uazapiConnectionErrorResponse(
  error: unknown
): NextResponse | null {
  if (error instanceof UazapiConnectionError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }

  if (isUazapiClientError(error)) {
    console.error('[uazapi] request failed', {
      operation: error.operation,
      kind: error.kind,
      httpStatus: error.httpStatus,
    });
    return NextResponse.json(
      { error: 'uazapi_request_failed', reason: error.kind },
      { status: 502 }
    );
  }

  return null;
}

/** Only the hash of the route secret is ever stored or compared. */
export function hashUazapiWebhookSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function defaultWebhookSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A deterministic prefix from the account id plus randomness. Never a
 * user name, phone or email: instance names are visible to the
 * installation operator and to UAZAPI.
 */
function buildInstanceName(accountId: string, suffix: string): string {
  const slug = accountId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return `wacrm-${slug}-${suffix}`;
}

export function buildUazapiWebhookUrl(siteUrl: string, secret: string): string {
  const origin = new URL(siteUrl).origin;
  return `${origin}/api/whatsapp/webhook/uazapi/${secret}`;
}

function toConnectionStatus(
  instance: UazapiInstance
): WhatsAppConnectionStatus {
  // An unrecognized upstream state is reported as an error rather than
  // guessed into a state the product would act on.
  return instance.status ?? 'error';
}

/** Stable reason code; upstream text stays server-side. */
function errorReason(error: unknown): string {
  return isUazapiClientError(error) ? error.kind : 'unknown_error';
}

function isMissingUpstreamResource(error: unknown): boolean {
  return isUazapiClientError(error) && error.kind === 'not_found';
}

function qrExpiry(qrCodeDataUrl: string | null, now: Date): string | null {
  if (qrCodeDataUrl === null) return null;
  return new Date(now.getTime() + UAZAPI_QR_TTL_SECONDS * 1000).toISOString();
}

function viewFromInstance(input: {
  instance: UazapiInstance;
  attemptId: string;
  now: Date;
}): UazapiConnectionView {
  const { instance, attemptId, now } = input;
  return {
    provider: 'uazapi',
    status: toConnectionStatus(instance),
    attemptId,
    qrCodeDataUrl: instance.qrCodeDataUrl,
    qrExpiresAt: qrExpiry(instance.qrCodeDataUrl, now),
    connectedPhone: instance.ownerPhone,
    connectedName: instance.profileName,
    connectedAvatarUrl: instance.profilePicUrl,
    error: null,
  };
}

/**
 * The public view of a stored configuration, for callers that already
 * hold the row and must not trigger an upstream call â€” a page load, or a
 * poller whose attempt has been superseded.
 */
export function uazapiViewFromStoredConfig(
  config: StoredWhatsAppConfig,
  overrides: Partial<UazapiConnectionView> = {}
): UazapiConnectionView {
  const status = config.status;
  return {
    provider: 'uazapi',
    status: (status as WhatsAppConnectionStatus) ?? 'disconnected',
    attemptId: config.connection_attempt_id ?? '',
    qrCodeDataUrl: null,
    qrExpiresAt: null,
    connectedPhone: config.connected_phone ?? null,
    connectedName: config.connected_name ?? null,
    connectedAvatarUrl: config.connected_avatar_url ?? null,
    error: config.last_connection_error ?? null,
    ...overrides,
  };
}

function requireUazapiConfig(
  config: StoredWhatsAppConfig | null
): StoredWhatsAppConfig {
  if (!config) throw new UazapiConnectionError('not_configured', 404);
  if (config.provider !== 'uazapi') {
    throw new UazapiConnectionError('wrong_provider');
  }
  return config;
}

function contextDefaults(ctx: UazapiConnectionContext) {
  return {
    now: ctx.now ? ctx.now() : new Date(),
    newSecret: ctx.generateWebhookSecret ?? defaultWebhookSecret,
    newAttemptId: ctx.generateAttemptId ?? (() => crypto.randomUUID()),
    newSuffix:
      ctx.generateInstanceSuffix ??
      (() => crypto.randomBytes(2).toString('hex')),
  };
}

/**
 * Starts pairing. Resumes the account's existing UAZAPI instance when one
 * is already provisioned; otherwise provisions a new one and performs the
 * destructive provider switch only after the remote side is ready.
 */
export async function beginUazapiConnection(
  ctx: UazapiConnectionContext
): Promise<BeginUazapiConnectionResult> {
  const config = await ctx.loadConfig();

  if (config?.provider === 'uazapi' && config.uazapi_instance_id) {
    const existingToken = await ctx.loadInstanceToken(config.id);
    if (existingToken !== null) {
      // Duplicate "start" clicks and page reloads continue the incomplete
      // pairing instead of leaving an orphaned instance behind.
      return {
        publicView: await regenerateUazapiQrCode(ctx),
        affected: null,
      };
    }
  }

  const { now, newSecret, newAttemptId, newSuffix } = contextDefaults(ctx);
  const instanceName = buildInstanceName(ctx.accountId, newSuffix());
  const created = await ctx.admin.createInstance({ name: instanceName });

  if (created.instance.id === null) {
    throw new UazapiConnectionError('missing_instance');
  }

  const client = ctx.instanceClientFor(created.token);
  const secret = newSecret();
  const attemptId = newAttemptId();

  try {
    await registerWebhook(ctx, client, secret);
  } catch (error) {
    // Compensate: an instance we cannot receive from is worse than none.
    await client.deleteInstance().catch(() => undefined);
    throw error;
  }

  let switched: ProviderSwitchResult;
  try {
    switched = await ctx.replaceConfig({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      uazapi_instance_id: created.instance.id,
      // The name we asked for, not the echo: an omitted `name` in the
      // response must not store an empty instance name.
      uazapi_instance_name: instanceName,
      uazapi_instance_token: encrypt(created.token),
      uazapi_webhook_secret_hash: hashUazapiWebhookSecret(secret),
      connection_attempt_id: attemptId,
    });
  } catch (error) {
    await client.deleteInstance().catch(() => undefined);
    throw error;
  }

  const affected: ProviderSwitchCounts = {
    cancelledBroadcasts: switched.cancelledBroadcasts,
    deactivatedAutomations: switched.deactivatedAutomations,
    draftedFlows: switched.draftedFlows,
    stoppedFlowRuns: switched.stoppedFlowRuns,
  };

  try {
    const connected = await client.connect();
    return {
      publicView: viewFromInstance({ instance: connected, attemptId, now }),
      affected,
    };
  } catch (error) {
    // The row is already UAZAPI and the instance is real, so this is
    // recoverable: the user can ask for a new QR on the same instance.
    const reason = errorReason(error);
    await ctx.updateConfig(switched.configId, {
      status: 'error',
      last_connection_error: reason,
      connection_checked_at: now.toISOString(),
    });

    return {
      publicView: {
        provider: 'uazapi',
        status: 'error',
        attemptId,
        qrCodeDataUrl: null,
        qrExpiresAt: null,
        connectedPhone: null,
        connectedName: null,
        connectedAvatarUrl: null,
        error: reason,
      },
      affected,
    };
  }
}

/**
 * Asks UAZAPI for the authoritative instance state and persists it. Used
 * by the Settings poller and by a page reload that resumes pairing.
 */
export async function refreshUazapiConnection(
  ctx: UazapiConnectionContext,
  input: { attemptId?: string }
): Promise<UazapiConnectionView> {
  const config = requireUazapiConfig(await ctx.loadConfig());
  const { now } = contextDefaults(ctx);

  // A poller from a superseded QR session must not overwrite the state of
  // the attempt that replaced it.
  if (
    input.attemptId !== undefined &&
    config.connection_attempt_id != null &&
    input.attemptId !== config.connection_attempt_id
  ) {
    return uazapiViewFromStoredConfig(config);
  }

  const token = await ctx.loadInstanceToken(config.id);
  if (token === null) throw new UazapiConnectionError('missing_token');

  const attemptId = config.connection_attempt_id ?? '';

  let instance: UazapiInstance;
  try {
    instance = await ctx.instanceClientFor(token).getStatus();
  } catch (error) {
    const reason = errorReason(error);
    await ctx.updateConfig(config.id, {
      status: 'error',
      last_connection_error: reason,
      connection_checked_at: now.toISOString(),
    });
    return uazapiViewFromStoredConfig(config, {
      status: 'error',
      attemptId,
      error: reason,
    });
  }

  const status = toConnectionStatus(instance);
  await ctx.updateConfig(config.id, {
    status,
    connected_phone: instance.ownerPhone,
    connected_name: instance.profileName,
    connected_avatar_url: instance.profilePicUrl,
    last_connection_error: null,
    connection_checked_at: now.toISOString(),
  });

  return viewFromInstance({ instance, attemptId, now });
}

/**
 * Registers the callback UAZAPI should post to, for a given secret.
 *
 * UAZAPI's simple mode creates the instance's single webhook or updates
 * it, so calling this again is safe and is how a corrected site URL takes
 * effect.
 */
async function registerWebhook(
  ctx: UazapiConnectionContext,
  client: UazapiInstanceClient,
  secret: string
): Promise<void> {
  await client.configureWebhook({
    enabled: true,
    url: buildUazapiWebhookUrl(ctx.siteUrl, secret),
    events: [...WEBHOOK_EVENTS],
    excludeMessages: [...WEBHOOK_EXCLUDED_MESSAGES],
    addUrlEvents: false,
    addUrlTypesMessages: false,
  });
}

/**
 * Issues a fresh QR on the instance the account already owns, rotates the
 * attempt id so responses from the expired session are ignored, and
 * re-registers the webhook.
 *
 * Re-registering matters: the callback URL is built from the
 * installation's site URL, and without this it stayed frozen at whatever
 * that was the very first time the account paired. An operator who fixed
 * a wrong site URL would reconnect, see "connected", and still receive
 * nothing — with no error anywhere to explain it.
 *
 * The route secret is rotated at the same time, because only its hash is
 * stored and the original cannot be recovered. That also retires the old
 * callback URL.
 */
export async function regenerateUazapiQrCode(
  ctx: UazapiConnectionContext
): Promise<UazapiConnectionView> {
  const config = requireUazapiConfig(await ctx.loadConfig());
  if (!config.uazapi_instance_id) {
    throw new UazapiConnectionError('missing_instance');
  }

  const token = await ctx.loadInstanceToken(config.id);
  if (token === null) throw new UazapiConnectionError('missing_token');

  const { now, newAttemptId, newSecret } = contextDefaults(ctx);
  const client = ctx.instanceClientFor(token);

  // Before the QR: a code scanned against a stale callback would connect
  // and then deliver nothing.
  const secret = newSecret();
  await registerWebhook(ctx, client, secret);

  const attemptId = newAttemptId();
  const instance = await client.connect();

  await ctx.updateConfig(config.id, {
    status: toConnectionStatus(instance),
    connection_attempt_id: attemptId,
    uazapi_webhook_secret_hash: hashUazapiWebhookSecret(secret),
    last_connection_error: null,
    connection_checked_at: now.toISOString(),
  });

  return viewFromInstance({ instance, attemptId, now });
}

/**
 * Re-applies the webhook subscription to an instance the account already
 * owns, without disturbing the paired session.
 *
 * The events a delivery is filtered by live at UAZAPI, not here: they are
 * written once, when the account pairs. So a release that changes which
 * events the CRM wants — as adding groups and own-phone messages did —
 * leaves every existing instance silently on the old subscription,
 * dropping the new traffic before it is ever sent. Until this existed the
 * only cure was to unpair and scan a QR code again, which asks the user
 * to fix something they did not break.
 *
 * It also repoints the callback at the site URL in use right now, which
 * is the other thing that can go stale on a long-lived instance.
 *
 * Nothing about the connection is written. Re-registering says nothing
 * about whether the phone is still paired, and recording a guess would
 * show a status nobody actually checked.
 */
export async function resyncUazapiWebhook(
  ctx: UazapiConnectionContext
): Promise<void> {
  const config = requireUazapiConfig(await ctx.loadConfig());
  if (!config.uazapi_instance_id) {
    throw new UazapiConnectionError('missing_instance');
  }

  const token = await ctx.loadInstanceToken(config.id);
  if (token === null) throw new UazapiConnectionError('missing_token');

  const { newSecret } = contextDefaults(ctx);
  const secret = newSecret();

  // The hash is stored only after UAZAPI accepted the new URL. Writing it
  // first would retire the callback that is still working and leave the
  // account receiving on neither.
  await registerWebhook(ctx, ctx.instanceClientFor(token), secret);

  await ctx.updateConfig(config.id, {
    uazapi_webhook_secret_hash: hashUazapiWebhookSecret(secret),
  });
}

/**
 * Ends the WhatsApp session but keeps the instance, so a failed switch to
 * Meta can still recover by generating a new QR on the same instance.
 *
 * Used by the config route: the UAZAPI session must stop before Meta
 * registers the number, but deleting the instance before Meta actually
 * succeeds would leave the account with no working provider at all.
 */
export async function disconnectUazapiInstance(
  ctx: UazapiConnectionContext
): Promise<void> {
  const config = requireUazapiConfig(await ctx.loadConfig());
  const token = await ctx.loadInstanceToken(config.id);

  if (token !== null) {
    try {
      await ctx.instanceClientFor(token).disconnect();
    } catch (error) {
      // Already gone upstream is the state we wanted anyway.
      if (!isMissingUpstreamResource(error)) throw error;
    }
  }

  await ctx.updateConfig(config.id, {
    status: 'disconnected',
    last_connection_error: null,
    connection_checked_at: (ctx.now ? ctx.now() : new Date()).toISOString(),
  });
}

/**
 * Removes the account's UAZAPI connection. The local row goes only after
 * the remote instance is confirmed gone, so a failure here never leaves an
 * instance running against a CRM that no longer knows about it.
 */
export async function removeUazapiConnection(
  ctx: UazapiConnectionContext
): Promise<void> {
  const config = requireUazapiConfig(await ctx.loadConfig());
  const token = await ctx.loadInstanceToken(config.id);

  if (token !== null) {
    const client = ctx.instanceClientFor(token);

    try {
      await client.disconnect();
    } catch (error) {
      // Deleting also ends the session, so a failed disconnect is not a
      // reason to keep the instance alive.
      if (!isUazapiClientError(error)) throw error;
    }

    try {
      await client.deleteInstance();
    } catch (error) {
      if (!isMissingUpstreamResource(error)) throw error;
    }
  }

  await ctx.deleteConfig(config.id);
}

// --- Supabase-backed context ---------------------------------------------

interface ServiceRoleDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(
    name: string,
    params: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

const CONFIG_COLUMNS =
  'id, provider, status, uazapi_instance_id, uazapi_instance_name, uazapi_webhook_secret_hash, connection_attempt_id, connected_phone, connected_name, connected_avatar_url, last_connection_error';

/**
 * Builds the production context. The database handle must be a
 * service-role client: `whatsapp_config_secrets` has no browser policies.
 */
export function createUazapiConnectionContext(options: {
  db: ServiceRoleDatabase;
  accountId: string;
  userId: string;
  installation: UazapiInstallation;
}): UazapiConnectionContext {
  const { db, accountId, userId, installation } = options;

  return {
    accountId,
    userId,
    siteUrl: installation.siteUrl,
    admin: createUazapiAdminClient({
      baseUrl: installation.baseUrl,
      adminToken: installation.adminToken,
    }),
    instanceClientFor: (instanceToken) =>
      createUazapiInstanceClient({
        baseUrl: installation.baseUrl,
        instanceToken,
      }),

    async loadConfig() {
      const { data, error } = await db
        .from('whatsapp_config')
        .select(CONFIG_COLUMNS)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) throw error;
      return (data as StoredWhatsAppConfig | null) ?? null;
    },

    async loadInstanceToken(configId) {
      const { data, error } = await db
        .from('whatsapp_config_secrets')
        .select('uazapi_instance_token')
        .eq('whatsapp_config_id', configId)
        .maybeSingle();
      if (error) throw error;

      const ciphertext = (data as { uazapi_instance_token?: string } | null)
        ?.uazapi_instance_token;
      if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
        return null;
      }
      return decrypt(ciphertext);
    },

    async replaceConfig(input) {
      return switchAccountToUazapi(db, {
        accountId: input.account_id,
        userId: input.user_id,
        instanceId: input.uazapi_instance_id,
        instanceName: input.uazapi_instance_name,
        encryptedInstanceToken: input.uazapi_instance_token,
        webhookSecretHash: input.uazapi_webhook_secret_hash,
        connectionAttemptId: input.connection_attempt_id,
      });
    },

    async updateConfig(configId, patch) {
      const { error } = await db
        .from('whatsapp_config')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', configId)
        .eq('account_id', accountId);
      if (error) throw error;
    },

    async deleteConfig(configId) {
      // whatsapp_config_secrets cascades from whatsapp_config.
      const { error } = await db
        .from('whatsapp_config')
        .delete()
        .eq('id', configId)
        .eq('account_id', accountId);
      if (error) throw error;
    },
  };
}
