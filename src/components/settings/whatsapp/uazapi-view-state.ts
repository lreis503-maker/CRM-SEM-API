import type { WhatsAppConnectionStatus } from '@/lib/whatsapp/providers/types';

/**
 * Turns a connection state into what the Settings panel should show.
 *
 * Kept as a pure function so every branch — expired QR, hibernated
 * session, unreadable expiry — is testable without rendering, and so the
 * panel itself holds no decision logic of its own.
 */
export interface UazapiViewInput {
  status: WhatsAppConnectionStatus;
  qrCodeDataUrl?: string | null;
  qrExpiresAt?: string | null;
  error?: string | null;
}

export type UazapiPrimaryAction =
  /** No instance yet: this is the destructive first connection. */
  | 'start'
  /** Ask for a fresh QR on the instance the account already owns. */
  | 'refresh_qr'
  /** Wake a hibernated session. */
  | 'reconnect'
  /** Try the failed step again on the same instance. */
  | 'retry'
  /** Nothing to press: either scanning is in progress, or it worked. */
  | 'none';

export type UazapiViewTone =
  'idle' | 'pending' | 'success' | 'warning' | 'error';

export interface UazapiViewState {
  showQr: boolean;
  /** Whether Settings should keep asking the server for a new state. */
  poll: boolean;
  qrExpired: boolean;
  /** Seconds until the QR expires, or null when no code is on screen. */
  secondsLeft: number | null;
  primaryAction: UazapiPrimaryAction;
  canRemove: boolean;
  tone: UazapiViewTone;
}

function remainingSeconds(expiresAt: string | null | undefined, now: Date) {
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return null;

  const expiry = Date.parse(expiresAt);
  // An unreadable expiry is treated as already gone. Showing a QR we
  // cannot time out would leave the user staring at a dead code.
  if (Number.isNaN(expiry)) return 0;

  return Math.max(0, Math.ceil((expiry - now.getTime()) / 1000));
}

export function deriveUazapiViewState(
  input: UazapiViewInput,
  now: Date
): UazapiViewState {
  const secondsLeft = remainingSeconds(input.qrExpiresAt, now);
  const hasQr =
    typeof input.qrCodeDataUrl === 'string' && input.qrCodeDataUrl.length > 0;
  const qrExpired = secondsLeft !== null && secondsLeft <= 0;
  const qrUsable = hasQr && secondsLeft !== null && !qrExpired;

  switch (input.status) {
    case 'connected':
      return {
        showQr: false,
        poll: false,
        qrExpired: false,
        secondsLeft: null,
        primaryAction: 'none',
        canRemove: true,
        tone: 'success',
      };

    case 'connecting':
      // Polling is tied to the QR window: once the code dies there is
      // nothing left to wait for, so the panel stops asking and offers a
      // new code instead of spinning for two more minutes.
      return {
        showQr: qrUsable,
        poll: qrUsable,
        qrExpired,
        // Reported even at zero: "expired" reads better with a countdown
        // that visibly reached the end than with a blank.
        secondsLeft,
        primaryAction: qrUsable ? 'none' : 'refresh_qr',
        canRemove: true,
        tone: 'pending',
      };

    case 'hibernated':
      return {
        showQr: false,
        poll: false,
        qrExpired: false,
        secondsLeft: null,
        primaryAction: 'reconnect',
        canRemove: true,
        tone: 'warning',
      };

    case 'error':
      return {
        showQr: false,
        poll: false,
        qrExpired: false,
        secondsLeft: null,
        primaryAction: 'retry',
        canRemove: true,
        tone: 'error',
      };

    case 'disconnected':
      return {
        showQr: false,
        poll: false,
        qrExpired: false,
        secondsLeft: null,
        primaryAction: 'refresh_qr',
        canRemove: true,
        tone: 'idle',
      };

    case 'not_configured':
    default:
      return {
        showQr: false,
        poll: false,
        qrExpired: false,
        secondsLeft: null,
        primaryAction: 'start',
        canRemove: false,
        tone: 'idle',
      };
  }
}
