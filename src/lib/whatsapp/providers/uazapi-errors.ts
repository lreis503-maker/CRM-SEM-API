/**
 * Typed failures and payload redaction for the UAZAPI transport.
 *
 * Nothing that reaches a log, an error message or an HTTP response may
 * carry an installation admin token, an instance token, a webhook secret
 * or QR image data. Redaction happens here, once, so every caller of the
 * client gets the same guarantee without remembering to ask for it.
 */

export type UazapiErrorKind =
  /** The CRM built an impossible request (bad base URL, missing field). */
  | 'invalid_request'
  /** UAZAPI rejected the admin token or the instance token. */
  | 'authentication'
  /** The instance, message or media does not exist upstream. */
  | 'not_found'
  /** The instance is in a state that refuses this operation right now. */
  | 'conflict'
  /** UAZAPI asked us to slow down. */
  | 'rate_limited'
  /** Timeout, network failure or a 5xx from UAZAPI. */
  | 'upstream_unavailable'
  /** A 2xx whose body does not match the documented contract. */
  | 'invalid_response';

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;

/**
 * Key names whose value is always a credential, a QR code or raw media.
 * Matched case-insensitively against the whole key, so `base64Data`,
 * `webhook_secret` and `admintoken` are all covered.
 */
const SENSITIVE_KEY_PATTERN =
  /(token|authorization|secret|password|apikey|api_key|qrcode|qr_code|paircode|pair_code|base64|binary|credential)/i;

/** A `data:` URL always carries an inline payload we must not keep. */
const DATA_URL_PATTERN = /^\s*data:[^,]*,/i;

/**
 * A long unbroken run of token characters. Real prose contains spaces, so
 * this only fires on things like an echoed token or a base64 blob that a
 * provider put inside an otherwise harmless `error` string.
 */
const TOKEN_SHAPED_PATTERN = /[A-Za-z0-9+/_=-]{24,}/g;

function sanitizeString(value: string): string {
  if (DATA_URL_PATTERN.test(value)) return REDACTED;

  const scrubbed = value.replace(TOKEN_SHAPED_PATTERN, REDACTED);
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return sanitizeString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return String(value);
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      return '[unserializable]';
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';

  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return objectValue
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(objectValue).slice(
      0,
      MAX_OBJECT_KEYS
    )) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      const sanitized = sanitizeValue(entry, depth + 1, seen);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Returns a copy of `value` that is safe to log, store or attach to an
 * error: credential-shaped keys are replaced, inline payloads are dropped
 * and the result is bounded in depth, breadth and string length.
 */
export function sanitizeUazapiError(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

/** Maps an HTTP status documented by UAZAPI onto a stable error kind. */
export function classifyUazapiHttpStatus(status: number): UazapiErrorKind {
  if (status === 400) return 'invalid_request';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'invalid_response';
}

/**
 * Kinds where trying the same call again could plausibly succeed. This is
 * only half the answer — see `UazapiClientError.retryable`, which also
 * requires the operation itself to be safe to repeat.
 */
const RETRYABLE_KINDS: ReadonlySet<UazapiErrorKind> = new Set([
  'conflict',
  'rate_limited',
  'upstream_unavailable',
]);

export interface UazapiClientErrorInit {
  /** Stable operation name, e.g. `instance.status` or `send.text`. */
  operation: string;
  kind: UazapiErrorKind;
  httpStatus?: number | null;
  /**
   * Whether repeating this operation cannot create duplicate side effects.
   * Reads and lifecycle reconciliation are idempotent; sends never are.
   */
  idempotent?: boolean;
  /**
   * True when the transport failed after the request may already have been
   * accepted upstream. An ambiguous send must never be repeated
   * automatically — the user has to decide to resend.
   */
  ambiguous?: boolean;
  /** Upstream body or context; always stored sanitized. */
  details?: unknown;
  cause?: unknown;
}

export class UazapiClientError extends Error {
  readonly code = 'uazapi_request_failed';
  readonly kind: UazapiErrorKind;
  readonly operation: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly details: unknown;

  constructor(init: UazapiClientErrorInit) {
    const status = init.httpStatus ?? null;
    // The message is deliberately built only from values we control, so it
    // stays safe to surface in a log line or a server-side diagnostic.
    super(
      `UAZAPI ${init.operation} failed: ${init.kind}${
        status === null ? '' : ` (HTTP ${status})`
      }`,
      init.cause === undefined ? undefined : { cause: init.cause }
    );

    this.name = 'UazapiClientError';
    this.kind = init.kind;
    this.operation = init.operation;
    this.httpStatus = status;
    this.ambiguous = init.ambiguous ?? false;
    this.retryable =
      (init.idempotent ?? false) && RETRYABLE_KINDS.has(init.kind);
    this.details =
      init.details === undefined
        ? undefined
        : sanitizeUazapiError(init.details);
  }
}

export function isUazapiClientError(
  value: unknown
): value is UazapiClientError {
  return value instanceof UazapiClientError;
}
