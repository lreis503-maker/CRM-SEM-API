/**
 * UAZAPI webhook payload -> the provider-neutral envelope.
 *
 * The supplied contract types the webhook `data` as an open map and spells
 * the event names two different ways, so this module reads defensively:
 * it recognizes what the contract documents, and anything else becomes a
 * quarantine result with a stable reason code. It never fills a gap with a
 * guess — a half-understood payload would create a real contact, a real
 * message and a real automation run from something we did not read.
 *
 * Three outcomes:
 *   - `event`      — recognized; hand it to the shared processors.
 *   - `ignored`    — recognized and deliberately not acted on (our own
 *                    echo, a group, a lifecycle state we do not track).
 *   - `quarantine` — not recognized; store a redacted sample and ack.
 */

import type {
  NormalizedChat,
  NormalizedConnectionUpdate,
  NormalizedContent,
  NormalizedInboundEvent,
  NormalizedInboundMessage,
  NormalizedSender,
  NormalizedStatusUpdate,
} from './types';

export type UazapiIgnoreReason =
  'sent_by_api' | 'not_a_chat' | 'untracked_status';

export type UazapiQuarantineReason =
  | 'body_not_an_object'
  | 'unknown_event'
  | 'missing_data'
  | 'missing_message_id'
  | 'missing_chat_id'
  | 'missing_sender_identity'
  | 'unknown_message_type'
  | 'unknown_connection_state';

export type UazapiNormalizeResult =
  | { outcome: 'event'; events: NormalizedInboundEvent[] }
  | { outcome: 'ignored'; reason: UazapiIgnoreReason }
  | {
      outcome: 'quarantine';
      reasonCode: UazapiQuarantineReason;
      eventName: string | null;
    };

/**
 * The contract spells these both ways: the webhook subscription uses
 * `messages` / `messages_update`, while the WebhookEvent schema enumerates
 * `message` / `status`. Both are accepted rather than guessed at.
 */
const MESSAGE_EVENTS = new Set(['messages', 'message']);
const STATUS_EVENTS = new Set(['messages_update', 'status']);
const CONNECTION_EVENTS = new Set(['connection']);

/**
 * Message types this release understands, in both the plain spelling the
 * contract shows and the protobuf spelling the same field sometimes
 * carries. Anything absent here is quarantined, not approximated.
 */
const MESSAGE_TYPES: Record<string, NormalizedContent['type']> = {
  text: 'text',
  conversation: 'text',
  extendedtextmessage: 'text',
  image: 'image',
  imagemessage: 'image',
  sticker: 'image',
  stickermessage: 'image',
  video: 'video',
  videomessage: 'video',
  audio: 'audio',
  audiomessage: 'audio',
  ptt: 'audio',
  myaudio: 'audio',
  document: 'document',
  documentmessage: 'document',
  location: 'location',
  locationmessage: 'location',
};

const STATUS_VALUES: Record<string, NormalizedStatusUpdate['status']> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'read',
  failed: 'failed',
  error: 'failed',
};

/** Lifecycle states that are real but not delivery outcomes. */
const UNTRACKED_STATUS_VALUES = new Set([
  'pending',
  'queued',
  'canceled',
  'cancelled',
]);

const CONNECTION_STATES = new Set([
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function quarantine(
  reasonCode: UazapiQuarantineReason,
  eventName: string | null
): UazapiNormalizeResult {
  return { outcome: 'quarantine', reasonCode, eventName };
}

function ignored(reason: UazapiIgnoreReason): UazapiNormalizeResult {
  return { outcome: 'ignored', reason };
}

/**
 * The instance id a payload claims to come from, when it names one.
 * Deliveries observed in practice carry `instanceName` instead, so this
 * is usually null — see `uazapiInstanceNameOf`.
 */
export function uazapiInstanceIdOf(payload: unknown): string | null {
  const body = asRecord(payload);
  if (!body) return null;
  // On a connection delivery `instance` is an object; asText rejects it.
  return asText(body.instance) ?? asText(body.instance_id);
}

/** The instance name a payload claims to come from, when it names one. */
export function uazapiInstanceNameOf(payload: unknown): string | null {
  const body = asRecord(payload);
  if (!body) return null;
  return (
    asText(body.instanceName) ?? asText(asRecord(body.instance)?.name ?? null)
  );
}

function eventNameOf(body: Record<string, unknown>): string | null {
  // `EventType` is what the provider actually sends. `event` is what the
  // contract documents, and on a status delivery it is an object rather
  // than a name, which `asText` rejects.
  return asText(body.EventType) ?? asText(body.event) ?? asText(body.type);
}

/**
 * Anything below this is far too small to be milliseconds since the epoch
 * (it would be 1973), so it is seconds. Messages arrive in milliseconds
 * and read receipts in seconds, in the same delivery.
 */
const SECONDS_CEILING = 1e11;

/** Missing or unreadable means "just now". */
function timestampToIso(value: unknown): string {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;

  if (!Number.isFinite(raw) || raw <= 0) return new Date().toISOString();

  return new Date(raw < SECONDS_CEILING ? raw * 1000 : raw).toISOString();
}

/** `5511999999999@s.whatsapp.net` -> `5511999999999`. */
function phoneFromJid(jid: string | null): string {
  if (jid === null) return '';
  const user = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{8,15}$/.test(user) ? user : '';
}

function isGroupChat(chatId: string | null): boolean {
  return chatId !== null && chatId.endsWith('@g.us');
}

/**
 * Threads the CRM stores: a person, or a group. A newsletter or channel
 * is neither — it is a broadcast feed with no one to reply to, and it is
 * acknowledged without being stored.
 */
function isStorableChat(chatId: string | null): boolean {
  if (chatId === null) return true;
  return (
    chatId.endsWith('@s.whatsapp.net') ||
    chatId.endsWith('@lid') ||
    chatId.endsWith('@g.us')
  );
}

function normalizeChat(
  data: Record<string, unknown>,
  chatId: string | null,
  isGroup: boolean
): NormalizedChat {
  return {
    externalId: chatId,
    // In a one-to-one thread the chat id is the other party's JID, which
    // is the only place their number appears on a message we sent.
    phone: isGroup ? '' : phoneFromJid(chatId),
    isGroup,
    name: isGroup ? (asText(data.groupName) ?? asText(data.chatName)) : null,
  };
}

function normalizeSender(
  data: Record<string, unknown>,
  fromMe: boolean
): NormalizedSender | null {
  const senderPn = asText(data.sender_pn);
  const senderLid = asText(data.sender_lid);
  const sender = asText(data.sender);
  const chatId = asText(data.chatid);

  const phone =
    phoneFromJid(senderPn) || phoneFromJid(sender) || phoneFromJid(chatId);

  // A LID survives the contact changing phone number, so it is preferred
  // as the stable identifier. A plain JID is the fallback.
  const lid = senderLid ?? (sender?.endsWith('@lid') ? sender : null);
  const jid = sender ?? senderPn ?? chatId;

  const externalId = lid ?? (jid && jid.endsWith('@lid') ? jid : jid);
  const externalIdKind = lid ? 'lid' : externalId ? 'jid' : null;

  if (!phone && !externalId) return null;

  const profileName =
    asText(data.senderName) ??
    asText(data.pushName) ??
    // A message typed on the linked phone has no push name — it is us.
    (fromMe ? 'Você' : null);

  return {
    phone,
    externalId: externalId ?? null,
    externalIdKind,
    parentExternalId: null,
    profileName,
    displayName: profileName ?? phone ?? externalId ?? '',
    username: null,
  };
}

function normalizeContent(
  data: Record<string, unknown>,
  messageId: string,
  type: NormalizedContent['type']
): NormalizedContent {
  const text = asText(data.text) ?? asText(data.caption);

  if (type === 'text') {
    return { type: 'text', text: text ?? '' };
  }
  if (type === 'location') {
    return { type: 'location', text: text ?? '[location]' };
  }
  if (type === 'interactive') {
    return { type: 'interactive', text: text ?? '', replyId: null };
  }

  const fileUrl = asText(data.fileURL) ?? asText(data.fileUrl);

  return {
    type,
    text,
    media: {
      externalMediaId: messageId,
      // With no link, the route asks /message/download for one.
      locator: fileUrl ? 'provider_url' : 'provider_id',
      locatorValue: fileUrl ?? messageId,
      mimeType: asText(data.mimetype) ?? asText(data.mimeType),
      fileName: asText(data.docName) ?? asText(data.fileName),
      fileSize:
        typeof data.fileSize === 'number' && Number.isFinite(data.fileSize)
          ? data.fileSize
          : null,
    },
  };
}

function normalizeMessage(
  data: Record<string, unknown>,
  eventName: string | null
): UazapiNormalizeResult {
  // Configured at the provider too, and checked again here: a message
  // this CRM sent is already stored, and letting an automation see its
  // own output is how a bot answers itself forever.
  if (data.wasSentByApi === true) return ignored('sent_by_api');

  const chatId = asText(data.chatid);
  // A newsletter or channel post has nobody to reply to.
  if (!isStorableChat(chatId)) return ignored('not_a_chat');

  const isGroup = data.isGroup === true || isGroupChat(chatId);
  // A group thread is keyed by its JID and has no number of its own, so
  // without a chat id there is nothing to key it by. Filing it under
  // whoever happened to speak would scatter one group across a contact
  // per member.
  if (isGroup && chatId === null) {
    return quarantine('missing_chat_id', eventName);
  }
  // Typed on the linked phone rather than received. Stored as the
  // business's own reply, never treated as something to react to.
  const fromMe = data.fromMe === true;

  const messageId = asText(data.messageid) ?? asText(data.id);
  if (messageId === null) {
    return quarantine('missing_message_id', eventName);
  }

  const sender = normalizeSender(data, fromMe);
  if (sender === null) {
    return quarantine('missing_sender_identity', eventName);
  }

  const rawType = asText(data.messageType) ?? asText(data.type);
  const type = rawType ? MESSAGE_TYPES[rawType.toLowerCase()] : undefined;
  if (!type) {
    return quarantine('unknown_message_type', eventName);
  }

  const event: NormalizedInboundMessage = {
    kind: 'message',
    provider: 'uazapi',
    externalMessageId: messageId,
    occurredAt: timestampToIso(data.messageTimestamp),
    fromMe,
    isGroup,
    sender,
    chat: normalizeChat(data, chatId, isGroup),
    content: normalizeContent(data, messageId, type),
    replyToExternalId: asText(data.quoted),
  };

  return { outcome: 'event', events: [event] };
}

/** A receipt can acknowledge several messages in one delivery. */
function statusMessageIds(data: Record<string, unknown>): string[] {
  const ids = data.MessageIDs ?? data.messageIds;
  if (Array.isArray(ids)) {
    return ids.map(asText).filter((id): id is string => id !== null);
  }
  const single = asText(data.messageid) ?? asText(data.id);
  return single === null ? [] : [single];
}

function normalizeStatus(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
  eventName: string | null
): UazapiNormalizeResult {
  const messageIds = statusMessageIds(data);
  if (messageIds.length === 0) {
    return quarantine('missing_message_id', eventName);
  }

  // `state` sits beside the envelope, `Type` inside it, `status` is what
  // the contract documents.
  const raw = (
    asText(body.state) ??
    asText(data.Type) ??
    asText(data.status) ??
    ''
  ).toLowerCase();
  if (UNTRACKED_STATUS_VALUES.has(raw)) return ignored('untracked_status');

  const status = STATUS_VALUES[raw];
  if (!status) return quarantine('unknown_message_type', eventName);

  const reason = asText(data.error) ?? asText(body.error);
  const occurredAt = timestampToIso(
    data.Timestamp ?? data.messageTimestamp ?? body.timestamp
  );

  const events = messageIds.map<NormalizedStatusUpdate>(
    (externalMessageId) => ({
      kind: 'status',
      provider: 'uazapi',
      externalMessageId,
      status,
      occurredAt,
      // UAZAPI reports a human-readable reason, not a numeric code.
      failure:
        status === 'failed' && reason
          ? { code: null, title: reason, details: null }
          : null,
    })
  );

  return { outcome: 'event', events };
}

function normalizeConnection(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
  eventName: string | null
): UazapiNormalizeResult {
  const raw = (
    asText(data.status) ??
    asText(data.state) ??
    asText(body.state) ??
    ''
  ).toLowerCase();
  if (!CONNECTION_STATES.has(raw)) {
    return quarantine('unknown_connection_state', eventName);
  }

  const owner = asText(body.owner) ?? asText(data.owner) ?? asText(data.jid);

  const event: NormalizedConnectionUpdate = {
    kind: 'connection',
    provider: 'uazapi',
    status: raw as NormalizedConnectionUpdate['status'],
    occurredAt: timestampToIso(data.Timestamp ?? body.timestamp),
    // The owner is a bare number here, not a JID.
    phone: (phoneFromJid(owner) || (owner ?? '')).match(/^\d{8,15}$/)
      ? phoneFromJid(owner) || owner
      : null,
    displayName: asText(data.profileName) ?? asText(body.profileName),
    avatarUrl: asText(data.profilePicUrl) ?? asText(body.profilePicUrl),
  };

  return { outcome: 'event', events: [event] };
}

export function normalizeUazapiWebhook(
  payload: unknown
): UazapiNormalizeResult {
  const body = asRecord(payload);
  if (!body) return quarantine('body_not_an_object', null);

  const eventName = eventNameOf(body);
  if (eventName === null) return quarantine('unknown_event', null);

  const isMessage = MESSAGE_EVENTS.has(eventName);
  const isStatus = STATUS_EVENTS.has(eventName);
  const isConnection = CONNECTION_EVENTS.has(eventName);

  if (!isMessage && !isStatus && !isConnection) {
    return quarantine('unknown_event', eventName);
  }

  // The contract promises a `data` wrapper. Real deliveries put the
  // message under `message`, a receipt under `event` and the connection
  // under `instance`. Both shapes are accepted.
  const data = isMessage
    ? (asRecord(body.message) ?? asRecord(body.data))
    : isStatus
      ? (asRecord(body.event) ?? asRecord(body.data))
      : (asRecord(body.instance) ?? asRecord(body.data));

  if (!data) return quarantine('missing_data', eventName);

  if (isMessage) return normalizeMessage(data, eventName);
  if (isStatus) return normalizeStatus(body, data, eventName);
  return normalizeConnection(body, data, eventName);
}
