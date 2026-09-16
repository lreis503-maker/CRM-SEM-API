/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 *
 * It lives in its own module so the provider adapters can raise it
 * without importing `send-message.ts`, which imports them back.
 * `send-message.ts` re-exports it, so every existing import path works.
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}
