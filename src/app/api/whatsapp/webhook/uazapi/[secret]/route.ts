import crypto from 'crypto';

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/whatsapp/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { createUazapiMediaResolver } from '@/lib/whatsapp/inbound/uazapi-media';
import {
  normalizeUazapiWebhook,
  uazapiInstanceIdOf,
} from '@/lib/whatsapp/inbound/uazapi-normalizer';
import { processInboundMessage } from '@/lib/whatsapp/inbound/process-inbound-message';
import { processStatusUpdate } from '@/lib/whatsapp/inbound/process-status-update';
import {
  purgeExpiredWebhookQuarantine,
  quarantineWebhookFailure,
} from '@/lib/whatsapp/inbound/webhook-quarantine';
import {
  TransientInboundError,
  type InboundDatabase,
  type NormalizedConnectionUpdate,
} from '@/lib/whatsapp/inbound/types';
import { resolveUazapiInstallation } from '@/lib/whatsapp/providers/account-capabilities';
import { createUazapiInstanceClient } from '@/lib/whatsapp/providers/uazapi-client';

// ============================================================
// The UAZAPI webhook.
//
// The supplied contract documents no signature and no authentication
// header, so the URL itself is the credential: a high-entropy secret in
// the path, of which only a SHA-256 hash is stored. An unknown secret
// answers 404 and reveals nothing about whether an account exists.
//
// Unlike the Meta route this processes before responding, because the
// status code is the answer: 200 means "handled, do not send it again",
// 503 means "we failed, please retry". Acknowledging first and failing
// afterwards would silently drop messages.
// ============================================================

export const maxDuration = 60;

/** Nothing UAZAPI legitimately sends approaches this. */
const MAX_BODY_BYTES = 1024 * 1024;

const CONFIG_COLUMNS =
  'id, account_id, user_id, provider, status, uazapi_instance_id, mirror_inbound_media';

interface UazapiConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  uazapi_instance_id: string | null;
  mirror_inbound_media?: boolean | null;
}

/** Only the hash is stored, so only the hash is ever compared. */
function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

async function readLimitedBody(
  request: Request
): Promise<{ raw: string } | { tooLarge: true }> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { tooLarge: true };
  }

  const raw = await request.text();
  // The declared length is advisory; the bytes are the truth.
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES)
    return { tooLarge: true };
  return { raw };
}

async function loadConfigBySecret(
  db: InboundDatabase,
  secret: string
): Promise<UazapiConfigRow | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CONFIG_COLUMNS)
    .eq('provider', 'uazapi')
    .eq('uazapi_webhook_secret_hash', hashSecret(secret))
    .maybeSingle();

  if (error) throw new TransientInboundError('config lookup failed');
  return (data as UazapiConfigRow | null) ?? null;
}

async function loadInstanceToken(
  db: InboundDatabase,
  configId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_config_secrets')
    .select('uazapi_instance_token')
    .eq('whatsapp_config_id', configId)
    .maybeSingle();

  if (error) throw new TransientInboundError('secret lookup failed');

  const ciphertext = (data as { uazapi_instance_token?: string } | null)
    ?.uazapi_instance_token;
  return typeof ciphertext === 'string' && ciphertext.length > 0
    ? decrypt(ciphertext)
    : null;
}

/**
 * A connection event only ever changes lifecycle state on the account's
 * own configuration row. It never touches messages or contacts.
 */
async function applyConnectionUpdate(
  db: InboundDatabase,
  config: UazapiConfigRow,
  event: NormalizedConnectionUpdate
): Promise<void> {
  const { error } = await db
    .from('whatsapp_config')
    .update({
      status: event.status,
      connected_phone: event.phone,
      connected_name: event.displayName,
      connected_avatar_url: event.avatarUrl,
      connection_checked_at: event.occurredAt,
      last_connection_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id);

  if (error) throw new TransientInboundError('connection update failed');
}

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> }
) {
  // Next.js 16 dynamic params are async; reading them synchronously is
  // an error, not a deprecation.
  const { secret } = await context.params;

  const body = await readLimitedBody(request);
  if ('tooLarge' in body) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.raw);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const db = supabaseAdmin() as unknown as InboundDatabase;

  try {
    const config = await loadConfigBySecret(db, secret);
    // Deliberately indistinguishable from a route that does not exist.
    if (!config)
      return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // When the payload names an instance it must be this account's. A
    // mismatch means someone replayed another instance's event at this
    // secret, and it gets the same blank 404.
    const claimedInstance = uazapiInstanceIdOf(payload);
    if (
      claimedInstance !== null &&
      config.uazapi_instance_id !== null &&
      claimedInstance !== config.uazapi_instance_id
    ) {
      console.warn(
        '[uazapi-webhook] instance mismatch for account',
        config.account_id
      );
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const result = normalizeUazapiWebhook(payload);

    if (result.outcome === 'ignored') {
      // Expected and deliberately not acted on — our own echo, a group,
      // a lifecycle state we do not track. Acknowledged, not recorded.
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    if (result.outcome === 'quarantine') {
      await quarantineWebhookFailure({
        db,
        accountId: config.account_id,
        configId: config.id,
        provider: 'uazapi',
        reasonCode: result.reasonCode,
        eventName: result.eventName,
        rawBody: body.raw,
        payload,
      });
      // 200 on purpose: retrying will not make an unreadable payload
      // readable, and UAZAPI would otherwise redeliver it forever.
      void purgeExpiredWebhookQuarantine(db);
      return NextResponse.json({ status: 'quarantined' }, { status: 200 });
    }

    const event = result.event;

    if (event.kind === 'connection') {
      await applyConnectionUpdate(db, config, event);
      return NextResponse.json({ status: 'received' }, { status: 200 });
    }

    if (event.kind === 'status') {
      await processStatusUpdate({ db, event });
      return NextResponse.json({ status: 'received' }, { status: 200 });
    }

    // A message needs the instance client, both to fetch media the
    // webhook did not link and to mirror it before the provider's
    // two-day retention runs out.
    const installation = resolveUazapiInstallation(process.env);
    const instanceToken = installation
      ? await loadInstanceToken(db, config.id)
      : null;

    const client =
      installation && instanceToken
        ? createUazapiInstanceClient({
            baseUrl: installation.baseUrl,
            instanceToken,
          })
        : null;

    await processInboundMessage({
      db,
      event,
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      resolveMedia: client
        ? createUazapiMediaResolver({
            client,
            // Default ON, matching the column default: losing an
            // attachment is the failure mode worth avoiding.
            storage:
              config.mirror_inbound_media !== false
                ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (db as any).storage
                : null,
            accountId: config.account_id,
            occurredAt: event.occurredAt,
          })
        : // No usable client: store the message without its attachment
          // rather than dropping the message itself.
          async (media) => ({ url: null, mimeType: media.mimeType }),
    });

    return NextResponse.json({ status: 'received' }, { status: 200 });
  } catch (error) {
    // 503 for everything unhandled, so UAZAPI redelivers instead of the
    // CRM silently losing a real message. The detail stays server-side.
    console.error(
      '[uazapi-webhook] delivery failed:',
      error instanceof TransientInboundError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'unknown'
    );
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 503 }
    );
  }
}
