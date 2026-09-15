import { describe, expect, it } from 'vitest';
import { isMessagingWindowOpen, messagingWindowClosesAt, MESSAGING_WINDOW_MS } from './messaging-window';

describe('isMessagingWindowOpen', () => {
  it('is closed when there is no last customer message', () => {
    expect(isMessagingWindowOpen(null)).toBe(false);
    expect(isMessagingWindowOpen(undefined)).toBe(false);
  });

  it('is open just under 24h after the last customer message', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const last = new Date(now.getTime() - MESSAGING_WINDOW_MS + 1000).toISOString();
    expect(isMessagingWindowOpen(last, now)).toBe(true);
  });

  it('is closed exactly at 24h and beyond', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const last = new Date(now.getTime() - MESSAGING_WINDOW_MS).toISOString();
    expect(isMessagingWindowOpen(last, now)).toBe(false);
  });

  it('is closed for an unparseable date', () => {
    expect(isMessagingWindowOpen('not-a-date')).toBe(false);
  });
});

describe('messagingWindowClosesAt', () => {
  it('returns null with no last customer message', () => {
    expect(messagingWindowClosesAt(null)).toBeNull();
  });

  it('returns 24h after the last customer message', () => {
    const last = '2026-01-01T00:00:00.000Z';
    expect(messagingWindowClosesAt(last)).toBe('2026-01-02T00:00:00.000Z');
  });
});
