/**
 * The single door between this CRM and a UAZAPI installation.
 *
 * Everything here follows the supplied UAZAPI OpenAPI 3.1 contract
 * (version 2.1.1) and nothing else: no undocumented endpoint, no guessed
 * field. Responses are read with runtime guards instead of casts, because
 * the contract leaves several envelopes loosely typed and a wrong cast
 * would turn a malformed upstream body into a silent CRM bug.
 *
 * Two deliberate rules, both security-relevant:
 *
 * 1. `admintoken` belongs to the installation and is sent only to
 *    `POST /instance/create`. Every per-account call uses that instance's
 *    own `token`. The two clients are separate types so a caller cannot
 *    accidentally hand the admin credential to an account-scoped call.
 * 2. Nothing retries. A read that failed can be retried by its caller
 *    (the error says so), but a send that timed out may already have
 *    reached WhatsApp, so repeating it would duplicate a real message.
 */

import {
  UazapiClientError,
  classifyUazapiHttpStatus,
  type UazapiErrorKind,
} from './uazapi-errors';

/** UAZAPI documents a 2 minute QR window; 15s is generous per request. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Nothing this client reads legitimately approaches 1 MiB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A QR PNG is a few KiB; anything near this is not a QR code. */
const MAX_QR_CODE_LENGTH = 512_000;

const QR_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const RAW_BASE64_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

export type UazapiInstanceStatus =
  'disconnected' | 'connecting' | 'connected' | 'hibernated';

const INSTANCE_STATUSES: readonly string[] = [
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
];

/**
 * The instance state this CRM cares about, already normalized. It never
 * carries the instance token: callers that need it get it once, from
 * `createInstance`, and store it encrypted.
 */
export interface UazapiInstance {
  id: string | null;
  name: string | null;
  status: UazapiInstanceStatus | null;
  connected: boolean;
  loggedIn: boolean;
  /** Normalized `data:image/...;base64,...` URL, never persisted. */
  qrCodeDataUrl: string | null;
  ownerPhone: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  lastDisconnectReason: string | null;
}

export interface UazapiCreatedInstance {
  instance: UazapiInstance;
  /** Plaintext instance token. Encrypt before storing; never log it. */
  token: string;
}

export interface UazapiCreateInstanceInput {
  name: string;
}

export interface UazapiWebhookConfig {
  url: string;
  events: readonly string[];
  excludeMessages?: readonly string[];
  enabled?: boolean;
  addUrlEvents?: boolean;
  addUrlTypesMessages?: boolean;
}

export interface UazapiTextInput {
  number: string;
  text: string;
  replyId?: string;
  trackSource?: string;
  trackId?: string;
}

/**
 * The v1 media kinds. `ptt` is how UAZAPI expresses a voice message; the
 * provider adapter maps CRM audio onto it.
 */
export type UazapiMediaType = 'image' | 'video' | 'audio' | 'ptt' | 'document';

export interface UazapiMediaInput {
  number: string;
  type: UazapiMediaType;
  /** Public URL of the file. Base64 uploads are out of scope for v1. */
  file: string;
  caption?: string;
  docName?: string;
  mimetype?: string;
  replyId?: string;
  trackSource?: string;
  trackId?: string;
}

export interface UazapiSendResult {
  /** Provider message id, used to match later status webhooks. */
  messageId: string;
  chatId: string | null;
  status: string | null;
  timestamp: number | null;
}

/** One thread as UAZAPI lists it. Carries no message content. */
export interface UazapiChatSummary {
  /** The chat JID, which is also how messages are asked for. */
  id: string;
  /** Group subject or contact push name, when the provider knows one. */
  name: string | null;
  isGroup: boolean;
}

export interface UazapiChatPage {
  chats: UazapiChatSummary[];
}

/**
 * Raw message records, exactly as they came back.
 *
 * History rows and webhook deliveries carry the same message shape, so
 * they are handed to the same normalizer rather than parsed twice — that
 * is the whole reason this is not narrowed here.
 */
export interface UazapiMessagePage {
  messages: Record<string, unknown>[];
}

export interface UazapiDownloadedMedia {
  fileUrl: string | null;
  mimeType: string | null;
}

export interface UazapiAdminClient {
  createInstance(
    input: UazapiCreateInstanceInput
  ): Promise<UazapiCreatedInstance>;
}

export interface UazapiInstanceClient {
  configureWebhook(input: UazapiWebhookConfig): Promise<void>;
  connect(): Promise<UazapiInstance>;
  getStatus(): Promise<UazapiInstance>;
  disconnect(): Promise<void>;
  deleteInstance(): Promise<void>;
  sendText(input: UazapiTextInput): Promise<UazapiSendResult>;
  sendMedia(input: UazapiMediaInput): Promise<UazapiSendResult>;
  downloadMessage(id: string): Promise<UazapiDownloadedMedia>;
  findChats(input: { limit: number; offset: number }): Promise<UazapiChatPage>;
  findMessages(input: {
    chatId: string;
    limit: number;
  }): Promise<UazapiMessagePage>;
}

export interface UazapiAdminClientOptions {
  baseUrl: string;
  adminToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface UazapiInstanceClientOptions {
  baseUrl: string;
  instanceToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// --- runtime guards -------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Accepts the two documented QR shapes — a raw base64 string or an image
 * data URL — and returns one normalized data URL an `<img>` can render.
 * Anything else is rejected rather than forwarded to the browser.
 */
export function normalizeUazapiQrCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QR_CODE_LENGTH) return null;

  if (trimmed.startsWith('data:')) {
    return QR_DATA_URL_PATTERN.test(trimmed) ? trimmed : null;
  }

  return RAW_BASE64_PATTERN.test(trimmed)
    ? `data:image/png;base64,${trimmed}`
    : null;
}

/**
 * Pulls the owner phone out of the documented `jid`, which the contract
 * types as "object or null" and examples show as `{ user, server }`.
 * A bare JID string is accepted too, since `/instance/connect` and
 * `/instance/status` do not guarantee the same shape.
 */
function extractOwnerPhone(jid: unknown): string | null {
  if (typeof jid === 'string') {
    const user = jid.split('@')[0]?.split(':')[0] ?? '';
    return /^\d{8,15}$/.test(user) ? user : null;
  }

  const record = asRecord(jid);
  const user = record ? asNonEmptyString(record.user) : null;
  return user !== null && /^\d{8,15}$/.test(user) ? user : null;
}

/**
 * Reads an instance out of every envelope the contract uses: the bare
 * instance, `{ instance }` (create/connect) and `{ instance, status }`
 * (status). Unknown states become `null` instead of a guess.
 */
function parseInstance(body: unknown): UazapiInstance {
  const envelope = asRecord(body) ?? {};
  const raw = asRecord(envelope.instance) ?? envelope;
  const statusEnvelope = asRecord(envelope.status);

  const rawStatus = asNonEmptyString(raw.status);
  const status =
    rawStatus !== null && INSTANCE_STATUSES.includes(rawStatus)
      ? (rawStatus as UazapiInstanceStatus)
      : null;

  const connected = asBoolean(
    statusEnvelope?.connected ?? envelope.connected,
    status === 'connected'
  );

  return {
    id: asNonEmptyString(raw.id),
    name: asNonEmptyString(raw.name),
    status,
    connected,
    loggedIn: asBoolean(statusEnvelope?.loggedIn ?? envelope.loggedIn, false),
    qrCodeDataUrl: normalizeUazapiQrCode(raw.qrcode),
    ownerPhone: extractOwnerPhone(
      statusEnvelope?.jid ?? envelope.jid ?? raw.jid
    ),
    profileName: asNonEmptyString(raw.profileName),
    profilePicUrl: asNonEmptyString(raw.profilePicUrl),
    lastDisconnectReason: asNonEmptyString(raw.lastDisconnectReason),
  };
}

// --- transport ------------------------------------------------------------

interface UazapiOperation {
  /** Stable name used in errors and logs, e.g. `send.text`. */
  name: string;
  /**
   * True when repeating the call cannot create a second side effect, so a
   * caller may safely retry it. Reads and lifecycle reconciliation qualify;
   * instance creation and message sends never do.
   */
  idempotent: boolean;
}

interface UazapiRequest {
  operation: UazapiOperation;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

interface UazapiTransport {
  request(input: UazapiRequest): Promise<unknown>;
}

function invalidRequest(operation: string, reason: string): UazapiClientError {
  return new UazapiClientError({
    operation,
    kind: 'invalid_request',
    httpStatus: null,
    details: { reason },
  });
}

function invalidResponse(
  operation: UazapiOperation,
  reason: string,
  httpStatus: number | null = null
): UazapiClientError {
  return new UazapiClientError({
    operation: operation.name,
    kind: 'invalid_response',
    httpStatus,
    idempotent: operation.idempotent,
    details: { reason },
  });
}

/**
 * Validates the installation base URL: HTTPS, no credentials, no path.
 * A tenant URL with a path would silently break every endpoint below, and
 * embedded credentials would end up in request logs.
 */
function normalizeBaseUrl(operation: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalidRequest(operation, 'base_url_unparsable');
  }

  if (url.protocol !== 'https:') {
    throw invalidRequest(operation, 'base_url_not_https');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidRequest(operation, 'base_url_has_credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw invalidRequest(operation, 'base_url_not_origin');
  }

  return url.origin;
}

function utf8Length(text: string): number {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so this shortcut is safe
  // and avoids encoding a large string just to measure it.
  if (text.length * 3 <= MAX_RESPONSE_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Reads at most `MAX_RESPONSE_BYTES`, streaming when the runtime gives us
 * a body stream so an oversized response is abandoned instead of buffered.
 */
async function readLimitedText(
  response: Response,
  operation: UazapiOperation
): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw invalidResponse(operation, 'response_too_large', response.status);
  }

  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    if (utf8Length(text) > MAX_RESPONSE_BYTES) {
      throw invalidResponse(operation, 'response_too_large', response.status);
    }
    return text;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        throw invalidResponse(operation, 'response_too_large', response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return text + decoder.decode();
}

/**
 * Parses a body the contract promises is JSON. An empty body is accepted
 * as `{}` because the void lifecycle operations do not always return one.
 */
function parseJsonBody(text: string, operation: UazapiOperation): unknown {
  if (text.trim().length === 0) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(operation, 'response_not_json');
  }
}

function describeTransportFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name.length > 0) return cause.name;
  return 'unknown_transport_error';
}

function createTransport(options: {
  operationLabel: string;
  baseUrl: string;
  authHeader: 'token' | 'admintoken';
  authValue: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): UazapiTransport {
  const origin = normalizeBaseUrl(options.operationLabel, options.baseUrl);

  if (asNonEmptyString(options.authValue) === null) {
    throw invalidRequest(options.operationLabel, 'missing_credential');
  }

  return {
    async request({ operation, method, path, body }) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [options.authHeader]: options.authValue,
      };

      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      let response: Response;
      try {
        // Exactly one attempt. See the file header.
        response = await options.fetchImpl(`${origin}${path}`, init);
      } catch (cause) {
        throw new UazapiClientError({
          operation: operation.name,
          kind: 'upstream_unavailable',
          httpStatus: null,
          idempotent: operation.idempotent,
          // A non-idempotent call that failed in transport may still have
          // been accepted upstream, so the caller must not repeat it.
          ambiguous: !operation.idempotent,
          details: { reason: describeTransportFailure(cause) },
          cause,
        });
      }

      if (!response.ok) {
        throw await buildHttpError(response, operation);
      }

      const parsed = parseJsonBody(
        await readLimitedText(response, operation),
        operation
      );
      if (typeof parsed !== 'object' || parsed === null) {
        throw invalidResponse(operation, 'response_not_an_object');
      }

      return parsed;
    },
  };
}

async function buildHttpError(
  response: Response,
  operation: UazapiOperation
): Promise<UazapiClientError> {
  const kind: UazapiErrorKind = classifyUazapiHttpStatus(response.status);

  let details: unknown;
  try {
    const text = await readLimitedText(response, operation);
    const parsed = parseJsonBody(text, operation);
    details =
      typeof parsed === 'object' && parsed !== null ? parsed : { body: text };
  } catch {
    // An unreadable error body must not replace the real HTTP failure.
    details = { reason: 'error_body_unreadable' };
  }

  return new UazapiClientError({
    operation: operation.name,
    kind,
    httpStatus: response.status,
    idempotent: operation.idempotent,
    details,
  });
}

/** Drops undefined entries so request bodies stay exactly as documented. */
function compact(entries: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function parseSendResult(
  body: unknown,
  operation: UazapiOperation
): UazapiSendResult {
  const record = asRecord(body) ?? {};
  // `messageid` is the WhatsApp id later status webhooks refer to; `id` is
  // UAZAPI's internal row id and is only a fallback.
  const messageId =
    asNonEmptyString(record.messageid) ?? asNonEmptyString(record.id);

  if (messageId === null) {
    throw invalidResponse(operation, 'missing_message_id');
  }

  return {
    messageId,
    chatId: asNonEmptyString(record.chatid),
    status: asNonEmptyString(record.status),
    timestamp: asFiniteNumber(record.messageTimestamp),
  };
}

// --- clients --------------------------------------------------------------

const CREATE_INSTANCE: UazapiOperation = {
  name: 'instance.create',
  idempotent: false,
};
const CONFIGURE_WEBHOOK: UazapiOperation = {
  name: 'webhook.configure',
  idempotent: true,
};
const CONNECT: UazapiOperation = { name: 'instance.connect', idempotent: true };
const STATUS: UazapiOperation = { name: 'instance.status', idempotent: true };
const DISCONNECT: UazapiOperation = {
  name: 'instance.disconnect',
  idempotent: true,
};
const DELETE_INSTANCE: UazapiOperation = {
  name: 'instance.delete',
  idempotent: true,
};
const SEND_TEXT: UazapiOperation = { name: 'send.text', idempotent: false };
const SEND_MEDIA: UazapiOperation = { name: 'send.media', idempotent: false };
const DOWNLOAD_MESSAGE: UazapiOperation = {
  name: 'message.download',
  idempotent: true,
};
const FIND_CHATS: UazapiOperation = { name: 'chat.find', idempotent: true };
const FIND_MESSAGES: UazapiOperation = {
  name: 'message.find',
  idempotent: true,
};

/**
 * Pulls a list out of an envelope whose shape the contract does not pin
 * down. A body that names no list at all is an empty page, not a broken
 * response: "this account has no chats" is a normal answer.
 */
function asRecordList(
  body: unknown,
  ...keys: string[]
): Record<string, unknown>[] {
  const raw = Array.isArray(body)
    ? body
    : keys
        .map((key) => (asRecord(body) ?? {})[key])
        .find((value): value is unknown[] => Array.isArray(value));

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function parseChatSummary(
  record: Record<string, unknown>
): UazapiChatSummary | null {
  // The list endpoint prefixes the WhatsApp fields; a webhook-shaped row
  // does not. Both spellings are accepted rather than guessed between.
  const id =
    asNonEmptyString(record.wa_chatid) ??
    asNonEmptyString(record.chatid) ??
    asNonEmptyString(record.id);
  // A chat with no id cannot be asked for, so it is dropped rather than
  // taking the rest of the page down with it.
  if (id === null) return null;

  return {
    id,
    name:
      asNonEmptyString(record.wa_name) ??
      asNonEmptyString(record.name) ??
      asNonEmptyString(record.wa_contactName) ??
      null,
    isGroup:
      asBoolean(record.wa_isGroup, false) ||
      asBoolean(record.isGroup, false) ||
      id.endsWith('@g.us'),
  };
}

/**
 * Installation-scoped client. It holds `UAZAPI_ADMIN_TOKEN` and can only
 * create instances, which is the single documented admin operation this
 * CRM needs.
 */
export function createUazapiAdminClient(
  options: UazapiAdminClientOptions
): UazapiAdminClient {
  const transport = createTransport({
    operationLabel: CREATE_INSTANCE.name,
    baseUrl: options.baseUrl,
    authHeader: 'admintoken',
    authValue: options.adminToken,
    fetchImpl: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return {
    async createInstance(input) {
      const name = asNonEmptyString(input.name);
      if (name === null) {
        throw invalidRequest(CREATE_INSTANCE.name, 'missing_instance_name');
      }

      const body = await transport.request({
        operation: CREATE_INSTANCE,
        method: 'POST',
        path: '/instance/create',
        body: { name },
      });

      const envelope = asRecord(body) ?? {};
      const instance = parseInstance(body);
      const token =
        asNonEmptyString(envelope.token) ??
        asNonEmptyString(asRecord(envelope.instance)?.token);

      if (instance.id === null || token === null) {
        throw invalidResponse(CREATE_INSTANCE, 'missing_instance_identity');
      }

      return { instance, token };
    },
  };
}

/**
 * Account-scoped client. It holds one instance token and never sees the
 * installation admin token.
 */
export function createUazapiInstanceClient(
  options: UazapiInstanceClientOptions
): UazapiInstanceClient {
  const transport = createTransport({
    operationLabel: STATUS.name,
    baseUrl: options.baseUrl,
    authHeader: 'token',
    authValue: options.instanceToken,
    fetchImpl: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  async function send(
    operation: UazapiOperation,
    path: string,
    body: Record<string, unknown>
  ): Promise<UazapiSendResult> {
    return parseSendResult(
      await transport.request({ operation, method: 'POST', path, body }),
      operation
    );
  }

  return {
    async configureWebhook(input) {
      await transport.request({
        operation: CONFIGURE_WEBHOOK,
        method: 'POST',
        path: '/webhook',
        body: compact({
          enabled: input.enabled ?? true,
          url: input.url,
          events: [...input.events],
          excludeMessages:
            input.excludeMessages === undefined
              ? undefined
              : [...input.excludeMessages],
          addUrlEvents: input.addUrlEvents ?? false,
          addUrlTypesMessages: input.addUrlTypesMessages ?? false,
        }),
      });
    },

    async connect() {
      // No `phone`: the contract returns a QR code only when it is absent.
      return parseInstance(
        await transport.request({
          operation: CONNECT,
          method: 'POST',
          path: '/instance/connect',
          body: {},
        })
      );
    },

    async getStatus() {
      return parseInstance(
        await transport.request({
          operation: STATUS,
          method: 'GET',
          path: '/instance/status',
        })
      );
    },

    async disconnect() {
      await transport.request({
        operation: DISCONNECT,
        method: 'POST',
        path: '/instance/disconnect',
        body: {},
      });
    },

    async deleteInstance() {
      await transport.request({
        operation: DELETE_INSTANCE,
        method: 'DELETE',
        path: '/instance',
      });
    },

    async sendText(input) {
      return send(
        SEND_TEXT,
        '/send/text',
        compact({
          number: input.number,
          text: input.text,
          replyid: input.replyId,
          track_source: input.trackSource,
          track_id: input.trackId,
        })
      );
    },

    async sendMedia(input) {
      return send(
        SEND_MEDIA,
        '/send/media',
        compact({
          number: input.number,
          type: input.type,
          file: input.file,
          text: input.caption,
          docName: input.docName,
          mimetype: input.mimetype,
          replyid: input.replyId,
          track_source: input.trackSource,
          track_id: input.trackId,
        })
      );
    },

    async downloadMessage(id) {
      const messageId = asNonEmptyString(id);
      if (messageId === null) {
        throw invalidRequest(DOWNLOAD_MESSAGE.name, 'missing_message_id');
      }

      const body = await transport.request({
        operation: DOWNLOAD_MESSAGE,
        method: 'POST',
        path: '/message/download',
        // Never base64: inbound media is mirrored from the link instead of
        // being pulled through this process' memory.
        body: { id: messageId, return_link: true, return_base64: false },
      });

      const record = asRecord(body) ?? {};
      return {
        fileUrl: asNonEmptyString(record.fileURL),
        mimeType: asNonEmptyString(record.mimetype),
      };
    },

    async findChats(input) {
      const body = await transport.request({
        operation: FIND_CHATS,
        method: 'POST',
        path: '/chat/find',
        body: {
          limit: input.limit,
          offset: input.offset,
          // Newest conversation first, so an import that is stopped
          // half-way has still brought in what the seller needs today.
          sort: '-wa_lastMsgTimestamp',
        },
      });

      return {
        chats: asRecordList(body, 'chats', 'data')
          .map(parseChatSummary)
          .filter((chat): chat is UazapiChatSummary => chat !== null),
      };
    },

    async findMessages(input) {
      const chatId = asNonEmptyString(input.chatId);
      if (chatId === null) {
        throw invalidRequest(FIND_MESSAGES.name, 'missing_chat_id');
      }

      const body = await transport.request({
        operation: FIND_MESSAGES,
        method: 'POST',
        path: '/message/find',
        body: {
          chatid: chatId,
          limit: input.limit,
          sort: '-messageTimestamp',
        },
      });

      return { messages: asRecordList(body, 'messages', 'data') };
    },
  };
}
