/**
 * A short-lived, redacted record of a webhook the CRM could not read.
 *
 * The point is to answer "what actually arrived?" without acting on it
 * and without keeping it. A quarantined sample never carries a token, a
 * QR code or media bytes, it is capped in size, and it deletes itself
 * after seven days.
 *
 * Every function here swallows its own failures: quarantine is a
 * diagnostic. A provider must never be told to redeliver a message
 * because we failed to write a note about it.
 */

import crypto from 'crypto';

import { sanitizeUazapiError } from '../providers/uazapi-errors';
import type { WhatsAppProvider } from '../providers/types';
import type { InboundDatabase } from './types';

/** Seven days, as agreed in the design. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The column is JSONB; a sample past this is not worth storing. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Wider than an error's limits: a quarantined sample is read by a person
 * trying to understand an unknown payload, so it keeps more structure.
 */
const SAMPLE_LIMITS = {
  maxDepth: 6,
  maxStringLength: 2048,
  maxArrayItems: 50,
  maxObjectKeys: 100,
};

/**
 * Redacts credentials and inline media, bounds the structure, and then
 * hard-caps the serialized size so one enormous payload cannot fill the
 * table.
 */
export function sanitizeWebhookPayload(payload: unknown): unknown {
  const sanitized = sanitizeUazapiError(payload, SAMPLE_LIMITS);

  const serialized = JSON.stringify(sanitized) ?? 'null';
  if (serialized.length <= MAX_PAYLOAD_BYTES) return sanitized;

  return {
    truncated: true,
    reason: 'payload_too_large',
    bytes: serialized.length,
    sample: serialized.slice(0, MAX_PAYLOAD_BYTES - 256),
  };
}

/**
 * SHA-256 of the raw body, taken before sanitization so two deliveries of
 * the same shape collapse onto one row even after redaction changes.
 */
export function fingerprintWebhookPayload(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export interface QuarantineWebhookInput {
  db: InboundDatabase;
  accountId: string;
  configId: string | null;
  provider: WhatsAppProvider;
  /** Stable code from the normalizer, e.g. `unknown_message_type`. */
  reasonCode: string;
  eventName: string | null;
  /** Exact bytes received, used only for the fingerprint. */
  rawBody: string;
  payload: unknown;
  now?: () => Date;
}

export async function quarantineWebhookFailure(
  input: QuarantineWebhookInput
): Promise<void> {
  const { db, accountId, provider, reasonCode } = input;
  const now = (input.now ?? (() => new Date()))();
  const fingerprint = fingerprintWebhookPayload(input.rawBody);
  const expiresAt = new Date(now.getTime() + RETENTION_MS).toISOString();

  try {
    // Read-modify-write rather than an upsert: the row carries a counter,
    // and Supabase cannot increment one in an upsert. A lost increment
    // under concurrency is acceptable for a diagnostic record.
    const { data: existing } = await db
      .from('whatsapp_webhook_quarantine')
      .select('id, occurrence_count')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .eq('reason_code', reasonCode)
      .eq('payload_fingerprint', fingerprint)
      .maybeSingle();

    if (existing) {
      const { error } = await db
        .from('whatsapp_webhook_quarantine')
        .update({
          occurrence_count: Number(existing.occurrence_count ?? 0) + 1,
          last_seen_at: now.toISOString(),
          // Renewed, so a shape that keeps arriving keeps its record.
          expires_at: expiresAt,
        })
        .eq('id', existing.id);
      if (error) {
        console.error('[quarantine] increment failed:', error.message);
      }
      return;
    }

    const { error } = await db.from('whatsapp_webhook_quarantine').insert({
      account_id: accountId,
      config_id: input.configId,
      provider,
      reason_code: reasonCode,
      event_name: input.eventName,
      payload_fingerprint: fingerprint,
      payload: sanitizeWebhookPayload(input.payload),
      occurrence_count: 1,
      first_seen_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: expiresAt,
    });

    if (error) {
      console.error('[quarantine] insert failed:', error.message);
    }
  } catch (err) {
    console.error(
      '[quarantine] write threw:',
      err instanceof Error ? err.message : err
    );
  }
}

// In-memory, per-process. Deliberately not persisted: the purge is
// idempotent and cheap, and the only thing this prevents is a busy
// webhook issuing the same DELETE on every single delivery.
let lastPurgeAt = 0;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Test seam: forget when the purge last ran. */
export function __resetQuarantinePurgeClock(): void {
  lastPurgeAt = 0;
}

/**
 * Deletes expired rows, at most once per process per day.
 *
 * Called from both authenticated cron routes and opportunistically after
 * a quarantine write, so records go away even when the affected account
 * stops producing webhooks entirely.
 */
export async function purgeExpiredWebhookQuarantine(
  db: InboundDatabase,
  nowFn: () => Date = () => new Date()
): Promise<void> {
  const now = nowFn();
  if (lastPurgeAt !== 0 && now.getTime() - lastPurgeAt < PURGE_INTERVAL_MS) {
    return;
  }
  lastPurgeAt = now.getTime();

  try {
    const { error } = await db
      .from('whatsapp_webhook_quarantine')
      .delete()
      .lt('expires_at', now.toISOString());

    if (error) {
      console.error('[quarantine] purge failed:', error.message);
    }
  } catch (err) {
    console.error(
      '[quarantine] purge threw:',
      err instanceof Error ? err.message : err
    );
  }
}
