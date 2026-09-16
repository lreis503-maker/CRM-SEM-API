/**
 * Who a message is addressed to, per provider.
 *
 * Meta and UAZAPI disagree about what an address is. Meta accepts a phone
 * number or a business-scoped user id; UAZAPI accepts a phone number or a
 * WhatsApp LID/JID. Neither can use the other's identifier, so resolving
 * the target is provider-specific and happens before any transport call.
 */

import { SendMessageError } from '../send-message-error';
import { resolveContactSendTarget } from '../wa-identity';
import type { WhatsAppProvider } from './types';

export interface ProviderSendTarget {
  provider: WhatsAppProvider;
  /** The value handed to the provider: digits, a BSUID, or a LID/JID. */
  target: string;
  /** True only for a phone number, which alone supports variant retries. */
  isPhone: boolean;
}

export interface SendTargetContact {
  id: string;
  phone?: string | null;
  wa_user_id?: string | null;
}

/** LIDs are preferred: they survive a contact changing phone number. */
const IDENTITY_KIND_PRIORITY = ['lid', 'jid'];

interface IdentityReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

/**
 * The Meta wording is kept verbatim: it is the message users already see
 * and that existing tests pin. UAZAPI gets its own, because "ID de
 * usuário do WhatsApp" names a Meta concept that does not apply there.
 */
function unreachable(
  provider: WhatsAppProvider,
  contact: SendTargetContact | null | undefined
): SendMessageError {
  if (contact?.phone) {
    return new SendMessageError(
      'bad_request',
      'Formato de telefone inválido',
      400
    );
  }

  return new SendMessageError(
    'bad_request',
    provider === 'meta'
      ? 'O contato não tem telefone nem ID de usuário do WhatsApp'
      : 'O contato não tem telefone nem identificador utilizável nesta conexão',
    400
  );
}

async function resolveUazapiIdentity(
  db: IdentityReader,
  accountId: string,
  contactId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_contact_identities')
    .select('external_id, kind')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('provider', 'uazapi');

  if (error) throw error;

  const rows = (data ?? []) as Array<{ external_id?: unknown; kind?: unknown }>;
  for (const kind of IDENTITY_KIND_PRIORITY) {
    const match = rows.find((row) => row.kind === kind);
    if (match && typeof match.external_id === 'string' && match.external_id) {
      return match.external_id;
    }
  }

  const fallback = rows.find(
    (row) => typeof row.external_id === 'string' && row.external_id
  );
  return fallback ? (fallback.external_id as string) : null;
}

export async function resolveProviderSendTarget(
  db: IdentityReader,
  accountId: string,
  provider: WhatsAppProvider,
  contact: SendTargetContact | null | undefined
): Promise<ProviderSendTarget> {
  if (!contact) throw unreachable(provider, contact);

  const metaTarget = resolveContactSendTarget(contact);

  if (provider === 'meta') {
    // Unchanged behaviour: phone first, business-scoped user id otherwise.
    if (!metaTarget) throw unreachable(provider, contact);
    return {
      provider,
      target: metaTarget.target,
      isPhone: metaTarget.isPhone,
    };
  }

  // UAZAPI: a valid phone is the best address. A Meta BSUID is useless
  // here, so `metaTarget` only counts when it actually is a phone.
  if (metaTarget?.isPhone) {
    return { provider, target: metaTarget.target, isPhone: true };
  }

  const identity = await resolveUazapiIdentity(db, accountId, contact.id);
  if (identity === null) throw unreachable(provider, contact);

  return { provider, target: identity, isPhone: false };
}
