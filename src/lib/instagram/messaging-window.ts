/**
 * Instagram's standard messaging window: free-form replies are only
 * allowed within 24h of the customer's last message. Outside it,
 * `POST /me/messages` returns error 1545041 ("Messaging window closed").
 * There is no generic template mechanism to send after it closes (unlike
 * WhatsApp), so the CRM just disables the composer.
 */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isMessagingWindowOpen(
  lastCustomerMessageAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false;
  const last = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < MESSAGING_WINDOW_MS;
}

export function messagingWindowClosesAt(
  lastCustomerMessageAt: string | null | undefined,
): string | null {
  if (!lastCustomerMessageAt) return null;
  const last = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(last)) return null;
  return new Date(last + MESSAGING_WINDOW_MS).toISOString();
}
