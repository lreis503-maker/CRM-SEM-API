/**
 * Provider-neutral delivery-status handling.
 *
 * Moved out of the Meta webhook route unchanged except for one thing:
 * every lookup by external message id now also matches on `provider`, so
 * a UAZAPI id can never update a Meta message the account sent before a
 * provider switch (and the reverse).
 */

import { dispatchWebhookEvent } from '../../webhooks/deliver';
import type { InboundDatabase, NormalizedStatusUpdate } from './types';

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down it.
//
// `failed` is NOT on this ladder. It is a terminal side branch valid only
// from the early states (pending / sent): once the provider has delivered,
// or the user has read or replied, a later "failed" event is a bug
// upstream or a spoof attempt and is ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`.
 */
export function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

/** `messages.error_code` is an INTEGER; a non-numeric code is dropped. */
function numericErrorCode(code: string | null): number | null {
  if (code === null || !/^\d+$/.test(code)) return null;
  return Number(code);
}

export async function processStatusUpdate(input: {
  db: InboundDatabase;
  event: NormalizedStatusUpdate;
}): Promise<void> {
  const { db, event } = input;
  const failure = event.failure;

  if (failure) {
    console.warn(
      `WhatsApp message ${event.externalMessageId} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    );
  }

  // 1) Mirror onto messages. No `.select()`: message_id is not unique
  //    (migration 009 — provider ids repeat across numbers), so this
  //    updates 0..N rows and must not assume a single row.
  const messageUpdate: Record<string, unknown> = { status: event.status };
  if (failure) {
    messageUpdate.error_code = numericErrorCode(failure.code);
    messageUpdate.error_title = failure.title;
    messageUpdate.error_details = failure.details;
  }

  const { error: msgErr } = await db
    .from('messages')
    .update(messageUpdate)
    .eq('message_id', event.externalMessageId)
    .eq('provider', event.provider);

  if (msgErr) {
    console.error('Error updating message status:', msgErr);
  }

  // 2) Mirror onto broadcast_recipients. Broadcasts are Meta-only, so a
  //    UAZAPI status never touches them — the id spaces are unrelated and
  //    a coincidental match would corrupt a broadcast's counters.
  if (event.provider === 'meta') {
    await mirrorOntoBroadcastRecipient(db, event);
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends). Runs
  //    last so a slow subscriber cannot delay the mirrors above. Bounded
  //    to one row purely to resolve the owning account for delivery.
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', event.externalMessageId)
    .eq('provider', event.provider)
    .limit(1)
    .maybeSingle();

  if (msgRow) {
    // PostgREST types the embed as an array; at runtime a to-one embed is
    // the object itself. Read through `unknown` rather than fighting it.
    const conv = msgRow.conversations as unknown as {
      account_id: string;
    } | null;
    const accountId = conv?.account_id;
    if (accountId) {
      await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
        whatsapp_message_id: event.externalMessageId,
        conversation_id: msgRow.conversation_id,
        status: event.status,
      });
    }
  }
}

async function mirrorOntoBroadcastRecipient(
  db: InboundDatabase,
  event: NormalizedStatusUpdate
): Promise<void> {
  const failure = event.failure;

  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', event.externalMessageId)
    .maybeSingle();

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr);
    return;
  }

  // Guard transitions — forward-only on the success ladder, and `failed`
  // only from pre-delivered states. The aggregate trigger on
  // broadcast_recipients re-derives the parent broadcast's counts.
  if (!recipient || !isValidStatusTransition(recipient.status, event.status)) {
    return;
  }

  const update: Record<string, unknown> = { status: event.status };
  if (event.status === 'sent') update.sent_at = event.occurredAt;
  if (event.status === 'delivered') update.delivered_at = event.occurredAt;
  if (event.status === 'read') update.read_at = event.occurredAt;
  // broadcast_recipients already has a free-text error_message column
  // (migration 001), so the reason is folded into it rather than adding
  // three more columns there.
  if (failure) {
    update.error_message =
      `[${failure.code}] ${failure.title}` +
      (failure.details ? `: ${failure.details}` : '');
  }

  const { error: recUpdateErr } = await db
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id);

  if (recUpdateErr) {
    console.error('Error updating broadcast recipient status:', recUpdateErr);
  }
}
