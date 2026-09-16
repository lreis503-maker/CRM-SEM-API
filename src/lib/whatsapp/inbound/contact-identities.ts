/**
 * Provider-specific identifiers attached to a contact.
 *
 * A UAZAPI sender is identified by a LID or a JID, not by a Meta
 * business-scoped user id, so those live in their own table instead of
 * sharing `contacts.wa_user_id`. The unique key on
 * `(account_id, provider, external_id)` is what stops the same person
 * forking into two contacts when WhatsApp stops disclosing their number.
 */

import { isUniqueViolation } from '../../contacts/dedupe';
import type { WhatsAppProvider } from '../providers/types';
import type { InboundDatabase, NormalizedSenderIdKind } from './types';

const TABLE = 'whatsapp_contact_identities';

export interface ExternalIdentity {
  accountId: string;
  provider: WhatsAppProvider;
  externalId: string;
  kind: NormalizedSenderIdKind;
}

/**
 * The contact already linked to this identifier, or null. Used when a
 * delivery carries no phone number at all.
 */
export async function findContactIdByExternalIdentity(
  db: InboundDatabase,
  identity: Pick<ExternalIdentity, 'accountId' | 'provider' | 'externalId'>
): Promise<string | null> {
  const { data, error } = await db
    .from(TABLE)
    .select('contact_id')
    .eq('account_id', identity.accountId)
    .eq('provider', identity.provider)
    .eq('external_id', identity.externalId)
    .maybeSingle();

  if (error) {
    console.error('[identities] lookup failed:', error.message);
    return null;
  }
  return (data?.contact_id as string | undefined) ?? null;
}

/**
 * Link an identifier to a contact, or refresh when it is already linked.
 *
 * Returns the contact the identifier belongs to after the call. On a
 * concurrent insert that claimed it first, the winning row is re-read and
 * returned rather than overwritten — the same shape as the phone dedupe.
 */
export async function attachExternalIdentity(
  db: InboundDatabase,
  identity: ExternalIdentity,
  contactId: string
): Promise<string> {
  const now = new Date().toISOString();

  const { data: existing } = await db
    .from(TABLE)
    .select('id, contact_id')
    .eq('account_id', identity.accountId)
    .eq('provider', identity.provider)
    .eq('external_id', identity.externalId)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from(TABLE)
      .update({ last_seen_at: now })
      .eq('id', existing.id);
    if (error) {
      console.error('[identities] touch failed:', error.message);
    }
    return (existing.contact_id as string) ?? contactId;
  }

  const { error } = await db.from(TABLE).insert({
    account_id: identity.accountId,
    contact_id: contactId,
    provider: identity.provider,
    external_id: identity.externalId,
    kind: identity.kind,
    created_at: now,
    last_seen_at: now,
  });

  if (error) {
    // Lost a race with a concurrent delivery. The identifier belongs to
    // whichever contact won; re-read rather than assuming ours.
    if (isUniqueViolation(error)) {
      const winner = await findContactIdByExternalIdentity(db, identity);
      if (winner) return winner;
    }
    console.error('[identities] attach failed:', error.message);
  }

  return contactId;
}
