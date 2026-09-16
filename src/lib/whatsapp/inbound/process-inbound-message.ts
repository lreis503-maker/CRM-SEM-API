/**
 * Everything the CRM does with an inbound message, for any provider.
 *
 * Moved out of the Meta webhook route with its behaviour intact: the same
 * contact and conversation resolution, the same single idempotency
 * boundary before any fan-out, the same dispatch order for flows,
 * automations, AI and public webhooks.
 *
 * What changed is the input. It now takes a normalized envelope instead of
 * a Meta payload, resolves media through an injected provider resolver,
 * and stamps `provider` on every row it writes and every external-id
 * lookup it makes.
 */

import { dispatchInboundToAiReply } from '../../ai/auto-reply';
import { runAutomationsForTrigger } from '../../automations/engine';
import { findExistingContact, isUniqueViolation } from '../../contacts/dedupe';
import { reopenClosedConversation } from '../../conversations/reopen';
import { dispatchInboundToFlows } from '../../flows/engine';
import { dispatchWebhookEvent } from '../../webhooks/deliver';
import {
  attachExternalIdentity,
  findContactIdByExternalIdentity,
  type ExternalIdentity,
} from './contact-identities';
import { normalizePhone } from '../phone-utils';
import type { WhatsAppProvider } from '../providers/types';
import type {
  InboundAvatarResolver,
  InboundDatabase,
  InboundMediaResolver,
  NormalizedInboundMessage,
  NormalizedSender,
} from './types';

/**
 * Who the conversation belongs to, which is not always who sent the
 * message:
 *
 * - a group thread belongs to the group, and every participant writes
 *   into it;
 * - a message the business typed on its own phone was sent by us, so the
 *   thread is the other party, named only by the chat.
 */
function threadSubject(event: NormalizedInboundMessage): {
  sender: NormalizedSender;
  isGroup: boolean;
} {
  const { chat, sender } = event;

  if (chat.isGroup) {
    const groupId = chat.externalId ?? '';
    return {
      isGroup: true,
      sender: {
        phone: '',
        externalId: groupId,
        externalIdKind: 'jid',
        parentExternalId: null,
        profileName: chat.name,
        displayName: chat.name ?? groupId,
        username: null,
      },
    };
  }

  if (event.fromMe) {
    const chatId = chat.externalId ?? '';
    return {
      isGroup: false,
      sender: {
        phone: chat.phone,
        externalId: chatId || null,
        externalIdKind: chatId ? 'jid' : null,
        parentExternalId: null,
        // The chat carries no profile name for the other party, and
        // guessing one from our own message would rename their contact.
        profileName: null,
        displayName: chat.phone || chatId,
        username: null,
      },
    };
  }

  return { isGroup: false, sender };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConversationRow = any;

export interface InboundParticipants {
  contact: ContactRow;
  /** True when this delivery created the row; drives new_contact_created. */
  contactWasCreated: boolean;
  conversation: ConversationRow;
  conversationWasCreated: boolean;
}

/**
 * Only a Meta business-scoped user id belongs on `contacts.wa_user_id`.
 * A UAZAPI LID/JID is stored in `whatsapp_contact_identities` instead, so
 * the two id spaces never collide in the same column.
 */
function bsuidOf(sender: NormalizedSender): string | null {
  return sender.externalIdKind === 'bsuid' ? sender.externalId : null;
}

/**
 * Look a contact up by BSUID. Exact match on the column backing migration
 * 040's unique index — a BSUID is opaque and has one correct spelling.
 */
async function findContactByWaUserId(
  db: InboundDatabase,
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle();

  if (error) {
    console.error('[inbound] BSUID contact lookup failed:', error.message);
    return null;
  }
  return data ?? null;
}

/**
 * Fields worth writing back onto a contact we just matched. Returns null
 * when nothing changed, so the common case costs no UPDATE.
 *
 * The identifier backfill is the important one: it stamps the provider id
 * onto a contact we have only ever known by phone, so the NEXT message —
 * which may arrive with no phone number at all — still resolves to this
 * row instead of forking a new one.
 */
function contactIdentityPatch(
  existing: ContactRow,
  sender: NormalizedSender
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  // Only ever from a label the provider actually supplied. `displayName`
  // falls back to the phone number or id, which is right for a brand-new
  // row but would clobber an agent's hand-edited name on every inbound
  // message from a contact with no WhatsApp profile name.
  const name = sender.profileName || sender.username;
  if (name && name !== existing.name) patch.name = name;

  const waUserId = bsuidOf(sender);
  if (waUserId && waUserId !== existing.wa_user_id) {
    patch.wa_user_id = waUserId;
  }
  if (
    sender.parentExternalId &&
    sender.parentExternalId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = sender.parentExternalId;
  }
  if (sender.username && sender.username !== existing.wa_username) {
    patch.wa_username = sender.username;
  }
  // Only ever fills a blank. An existing number is left alone — the send
  // path's variant retry owns correcting it, and a provider's formatting
  // differences are not a reason to rewrite it.
  if (sender.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = sender.phone;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The provider identifier to file under `whatsapp_contact_identities`.
 * Null for Meta, whose BSUID lives on the contact row itself.
 */
function externalIdentityOf(
  provider: WhatsAppProvider,
  sender: NormalizedSender
): ExternalIdentity | null {
  if (
    sender.externalId === null ||
    sender.externalIdKind === null ||
    sender.externalIdKind === 'bsuid'
  ) {
    return null;
  }
  return {
    accountId: '',
    provider,
    externalId: sender.externalId,
    kind: sender.externalIdKind,
  };
}

async function loadContactById(
  db: InboundDatabase,
  accountId: string,
  contactId: string
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', contactId)
    .maybeSingle();
  if (error) {
    console.error('[inbound] contact load failed:', error.message);
    return null;
  }
  return data ?? null;
}

/**
 * The identifier `/chat/details` accepts: a bare phone for an individual
 * (matching what the send path already sends as `number`), or the JID/LID
 * for a group or an id-only sender. Null when neither is known.
 */
function avatarLookupKey(sender: NormalizedSender): string | null {
  return sender.phone || sender.externalId;
}

/**
 * Best-effort photo lookup. A failure or a missing resolver (every
 * provider but UAZAPI) yields null rather than blocking contact creation.
 */
async function resolveAvatarUrl(
  resolveAvatar: InboundAvatarResolver | undefined,
  sender: NormalizedSender
): Promise<string | null> {
  if (!resolveAvatar) return null;
  const key = avatarLookupKey(sender);
  if (!key) return null;

  try {
    return await resolveAvatar(key);
  } catch (error) {
    console.error('[inbound] avatar lookup failed:', error);
    return null;
  }
}

async function findOrCreateContact(
  db: InboundDatabase,
  accountId: string,
  configOwnerUserId: string,
  provider: WhatsAppProvider,
  sender: NormalizedSender,
  isGroup = false,
  resolveAvatar?: InboundAvatarResolver
): Promise<{ contact: ContactRow; wasCreated: boolean } | null> {
  const waUserId = bsuidOf(sender);
  const identity = externalIdentityOf(provider, sender);
  const scopedIdentity = identity ? { ...identity, accountId } : null;

  // BSUID first when we have one. It is stable per (user, business
  // portfolio) and, unlike the phone number, Meta keeps sending it — so it
  // is the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = waUserId
    ? await findContactByWaUserId(db, accountId, waUserId)
    : null;

  // Fall back to the phone. The shared helper pre-filters in SQL by the
  // last-8-digit suffix then applies the strict `phonesMatch` in JS on the
  // small candidate set. The same helper backs the manual contact form and
  // CSV import, so all three paths agree on what "same number" means
  // (issue #212).
  if (!existingContact && sender.phone && !isGroup) {
    existingContact = await findExistingContact(db, accountId, sender.phone);
  }

  // Last resort: the provider identifier we filed the last time this
  // person wrote. This is what resolves a LID-only delivery — one that
  // carries no phone number at all — back onto the existing contact
  // instead of forking a second one.
  if (!existingContact && scopedIdentity) {
    const linkedId = await findContactIdByExternalIdentity(db, scopedIdentity);
    if (linkedId) {
      existingContact = await loadContactById(db, accountId, linkedId);
    }
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, sender);
    // Only ever fills a blank, same rule as the phone backfill above: a
    // contact that already has a photo is not re-fetched on every
    // message, which would mean one extra provider round-trip per
    // inbound message forever.
    const avatarUrl = existingContact.avatar_url
      ? null
      : await resolveAvatarUrl(resolveAvatar, sender);
    const combinedPatch =
      patch || avatarUrl ? { ...patch, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) } : null;
    if (combinedPatch) {
      const { data: updated, error: updateError } = await db
        .from('contacts')
        .update({ ...combinedPatch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle();

      if (updateError) {
        // A backfill can lose a race with a concurrent delivery that
        // already claimed the id for another row. Not fatal — the message
        // still belongs to the contact we matched.
        console.error(
          '[inbound] contact identity backfill failed:',
          updateError.message
        );
      } else if (updated) {
        existingContact = updated;
      }
    }
    if (scopedIdentity) {
      // File the identifier against this contact so the next delivery
      // resolves even if the phone number is withheld. If a concurrent
      // delivery already claimed it for another row, that row wins.
      const owner = await attachExternalIdentity(
        db,
        scopedIdentity,
        existingContact.id
      );
      if (owner !== existingContact.id) {
        const winner = await loadContactById(db, accountId, owner);
        if (winner) return { contact: winner, wasCreated: false };
      }
    }
    return { contact: existingContact, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column; user_id is the
  // NOT NULL FK audit column (no inbound message has a single "user who
  // created" it — we attribute to the WhatsApp config owner).
  //
  // `phone` stays NOT NULL in the schema, so an id-only sender is stored
  // with '' — which migration 022's partial unique index tolerates.
  const avatarUrl = await resolveAvatarUrl(resolveAvatar, sender);
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: sender.phone,
      name: sender.displayName,
      is_group: isGroup,
      wa_user_id: waUserId,
      wa_parent_user_id: sender.parentExternalId,
      wa_username: sender.username,
      avatar_url: avatarUrl,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent delivery created this contact between our
    // lookup and insert. Re-resolve instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = waUserId
        ? await findContactByWaUserId(db, accountId, waUserId)
        : null;
      if (raced) return { contact: raced, wasCreated: false };
      if (sender.phone) {
        const racedByPhone = await findExistingContact(
          db,
          accountId,
          sender.phone
        );
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false };
      }
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  if (scopedIdentity) {
    await attachExternalIdentity(db, scopedIdentity, newContact.id);
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  db: InboundDatabase,
  accountId: string,
  configOwnerUserId: string,
  contactId: string
): Promise<{ conversation: ConversationRow; created: boolean } | null> {
  // Deliberately not `.single()`. It errors on both 0 rows and ≥2 rows,
  // and treating any error as "none found" is what snowballed duplicate
  // chats once two conversations existed for a contact (issue #363).
  //
  // Ordering oldest-first resolves to the same canonical survivor the
  // dedup migration (036) keeps, so pre-existing duplicates converge.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race — mirrors findOrCreateContact above.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}

/**
 * Resolve (or open) the contact and conversation an inbound event belongs
 * to, emitting `conversation.created` when the thread is new.
 *
 * Exported because a Meta reaction needs the same participants without
 * being a message: it is per-(target, actor) state, never a row in
 * `messages`.
 */
export async function resolveInboundParticipants(input: {
  db: InboundDatabase;
  accountId: string;
  configOwnerUserId: string;
  provider: WhatsAppProvider;
  sender: NormalizedSender;
  /** True when the subject is a group rather than a person. */
  isGroup?: boolean;
  /** UAZAPI only — Meta has no equivalent lookup. */
  resolveAvatar?: InboundAvatarResolver;
}): Promise<InboundParticipants | null> {
  const { db, accountId, configOwnerUserId, provider, sender, resolveAvatar } =
    input;

  const contactOutcome = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    provider,
    sender,
    input.isGroup ?? false,
    resolveAvatar
  );
  if (!contactOutcome) return null;

  const convResult = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id
  );
  if (!convResult) return null;

  // Emitted as soon as the thread is opened — before any message exists —
  // so a thread first opened by a reaction still fires the event, and a
  // subscriber always sees the thread open before its first
  // message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contactOutcome.contact.id,
    });
  }

  return {
    contact: contactOutcome.contact,
    contactWasCreated: contactOutcome.wasCreated,
    conversation: convResult.conversation,
    conversationWasCreated: convResult.created,
  };
}

/**
 * Resolve the reply target's internal UUID, scoped to one conversation
 * and one provider. Null when we never received the parent.
 */
async function lookupInternalIdByExternalId(
  db: InboundDatabase,
  provider: WhatsAppProvider,
  externalId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', externalId)
    .eq('provider', provider)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[inbound] reply-target lookup failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort.
 */
async function flagBroadcastReplyIfAny(
  db: InboundDatabase,
  accountId: string,
  contactId: string
): Promise<void> {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id);

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}

export interface ProcessInboundMessageInput {
  db: InboundDatabase;
  event: NormalizedInboundMessage;
  accountId: string;
  /** Sender-of-record for inserts needing a NOT NULL user_id FK. */
  configOwnerUserId: string;
  resolveMedia: InboundMediaResolver;
  /** UAZAPI only — Meta has no equivalent lookup. */
  resolveAvatar?: InboundAvatarResolver;
  /** Pre-resolved participants, when the caller already looked them up. */
  participants?: InboundParticipants;
  /**
   * True when backfilling history. An imported message is a record of
   * something that already happened: it is stored and shown, but it
   * never bumps unread, advances a flow, fires an automation, triggers
   * an AI reply, or reaches an outbound webhook subscriber.
   */
  imported?: boolean;
}

export async function processInboundMessage(
  input: ProcessInboundMessageInput
): Promise<void> {
  const { db, event, accountId, configOwnerUserId, resolveMedia, resolveAvatar } =
    input;

  const subject = threadSubject(event);
  const participants =
    input.participants ??
    (await resolveInboundParticipants({
      db,
      accountId,
      configOwnerUserId,
      provider: event.provider,
      sender: subject.sender,
      isGroup: subject.isGroup,
      resolveAvatar,
    }));
  if (!participants) return;

  const { contact, conversation } = participants;

  const content = event.content;
  // Empty text is stored as NULL, not '', so the inbox renders nothing
  // rather than an empty bubble — matching the pre-extraction behaviour.
  const contentText = ('text' in content ? content.text : null) || null;
  const interactiveReplyId =
    content.type === 'interactive' ? content.replyId : null;

  // Media is fetched through the provider's own resolver; a failure there
  // leaves the message stored without an attachment rather than making the
  // provider redeliver everything.
  let mediaUrl: string | null = null;
  let mediaType: string | null = null;
  if ('media' in content && content.media) {
    const resolved = await resolveMedia(content.media);
    mediaUrl = resolved.url;
    mediaType = resolved.mimeType ?? content.media.mimeType;
  }

  // Resolve a quoted parent if present. A missing parent is fine — we
  // store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null;
  if (event.replyToExternalId) {
    replyToInternalId = await lookupInternalIdByExternalId(
      db,
      event.provider,
      event.replyToExternalId,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[inbound] reply context parent not found:',
        event.replyToExternalId
      );
    }
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE the insert, so the count is accurate. Covers the case where the
  // contact row already exists (manual add / CSV import) but they have
  // never messaged us before — which new_contact_created would not catch.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  // Idempotent insert. Providers retry deliveries (a slow ack, a transient
  // 5xx), and each retry replays the same message id. The unique index on
  // (conversation_id, provider, message_id) makes a replay conflict;
  // `ignoreDuplicates` turns that into ON CONFLICT DO NOTHING, and the
  // `.select()` returns a row ONLY on a genuine first insert. This is the
  // single idempotency boundary, and it must sit BEFORE the unread bump
  // and all downstream fan-out (issue #367).
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        provider: event.provider,
        // A message typed on the linked phone is the business speaking,
        // not the customer, and the inbox must not read it as a reply
        // waiting to be answered.
        sender_type: event.fromMe ? 'agent' : 'customer',
        // Only meaningful in a group, where the thread has many voices.
        author_name: event.isGroup ? event.sender.displayName : null,
        imported: input.imported ?? false,
        content_type: content.type,
        content_text: contentText,
        media_url: mediaUrl,
        media_type: mediaType,
        message_id: event.externalMessageId,
        status: 'delivered',
        created_at: event.occurredAt,
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'.
        interactive_reply_id: interactiveReplyId,
      },
      {
        onConflict: 'conversation_id,provider,message_id',
        ignoreDuplicates: true,
      }
    )
    .select('id');

  if (msgError) {
    console.error('Error inserting message:', msgError);
    return;
  }

  // Replayed delivery: acknowledge as a no-op. Returning here is what
  // keeps a retry from double-bumping unread, re-advancing flows,
  // re-firing automations, re-invoking AI, and re-dispatching public
  // webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[inbound] duplicate inbound message ignored (idempotent replay):',
      event.externalMessageId
    );
    return;
  }

  // Only a message from the customer, arriving live, is something to
  // react to. Our own message is the business speaking; an imported one
  // already happened, possibly months ago. Both are stored and shown,
  // and neither raises unread, runs automations, wakes the AI, or
  // reaches a webhook subscriber — doing that on a backfill would send
  // real people a burst of messages about conversations long finished.
  const isActionable = !event.fromMe && input.imported !== true;

  const preview = contentText || `[${content.type}]`;

  if (isActionable) {
    // The unread bump is done DB-side (migration 037's
    // bump_conversation_on_inbound) rather than as a read-modify-write:
    // two inbound messages for the same conversation can process
    // concurrently, and computing `snapshot + 1` in the app let both
    // reads see the same value and write the same increment, losing one
    // (#369).
    const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
      p_conversation_id: conversation.id,
      p_last_message_text: preview,
    });

    if (convError) {
      console.error('Error updating conversation:', convError);
    }
  } else if (input.imported !== true) {
    // Our own live message still moves the thread to the top of the
    // list and updates its preview; it just does not mark it unread.
    const { error: convError } = await db
      .from('conversations')
      .update({
        last_message_text: preview,
        last_message_at: event.occurredAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    if (convError) {
      console.error('Error updating conversation:', convError);
    }
  }

  if (!isActionable) return;

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate statement so the write can be gated on the row's CURRENT
  // status in SQL — see the helper for why that matters.
  await reopenClosedConversation(db, conversation);

  await flagBroadcastReplyIfAny(db, accountId, contact.id);

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it advanced an active run or
  // started a new one), the `new_message_received` + `keyword_match`
  // automation triggers are suppressed for this inbound: the customer is
  // navigating the bot menu, not sending a fresh trigger word.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire — those are about WHO is
  // messaging, not what they said.
  //
  // Awaited because the `consumed` result decides the next step. The
  // runner owns its try/catch and never throws.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: event.externalMessageId,
        }
      : {
          kind: 'text',
          text: contentText ?? '',
          meta_message_id: event.externalMessageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  const inboundText = contentText ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    // Interactive tap → fire the interactive_reply trigger too. Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  // new_contact_created fires only when this delivery auto-created the
  // contact row. first_inbound_message fires whenever this is the
  // contact's first-ever customer message — a superset that also catches
  // manually-imported contacts messaging for the first time.
  if (participants.contactWasCreated) {
    automationTriggers.unshift('new_contact_created');
  }
  if (isFirstInboundMessage) {
    automationTriggers.unshift('first_inbound_message');
  }

  // Awaited, not fire-and-forget: we run inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through (issue #301 one
  // level down). `runAutomationsForTrigger` owns its try/catch; the
  // `.catch` is belt-and-braces so one trigger's failure cannot skip the
  // rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply. Only for plain-text inbound the deterministic flow
  // runner did NOT consume (flows win over the LLM), and only when the
  // account has enabled it. `dispatchInboundToAiReply` owns its
  // eligibility gates and try/catch, and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId,
      inboundMessageId: event.externalMessageId,
    });
  }

  // message.received webhook (public API). Awaited for the same
  // `after()` reason as the dispatches above. (conversation.created is
  // emitted earlier, right after the thread is opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: event.externalMessageId,
    content_type: content.type,
    text: contentText,
  });
}
