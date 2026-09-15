import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchWebhookEvent = vi.hoisted(() => vi.fn());
vi.mock('../../webhooks/deliver', () => ({ dispatchWebhookEvent }));

import {
  isValidStatusTransition,
  processStatusUpdate,
} from './process-status-update';
import type { InboundDatabase, NormalizedStatusUpdate } from './types';

interface Filter {
  table: string;
  column: string;
  value: unknown;
}

function fakeDb(options: { recipient?: unknown; messageRow?: unknown } = {}) {
  const filters: Filter[] = [];
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];

  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push({ table, column, value });
          return builder;
        },
        limit: () => builder,
        update: (patch: Record<string, unknown>) => {
          writes.push({ table, patch });
          return builder;
        },
        maybeSingle: async () => ({
          data:
            table === 'broadcast_recipients'
              ? (options.recipient ?? null)
              : (options.messageRow ?? null),
          error: null,
        }),
        then: (resolve: (r: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return builder;
    },
  };

  return { db: db as unknown as InboundDatabase, filters, writes };
}

function event(
  overrides: Partial<NormalizedStatusUpdate> = {}
): NormalizedStatusUpdate {
  return {
    kind: 'status',
    provider: 'meta',
    externalMessageId: 'wamid.1',
    status: 'delivered',
    occurredAt: '2026-09-15T12:00:00.000Z',
    failure: null,
    ...overrides,
  };
}

beforeEach(() => {
  dispatchWebhookEvent.mockReset();
  dispatchWebhookEvent.mockResolvedValue(undefined);
});

describe('processStatusUpdate', () => {
  it('scopes every external-id lookup to the provider', async () => {
    const { db, filters } = fakeDb();

    await processStatusUpdate({ db, event: event({ provider: 'uazapi' }) });

    const messageFilters = filters.filter((f) => f.table === 'messages');
    expect(messageFilters).toContainEqual({
      table: 'messages',
      column: 'provider',
      value: 'uazapi',
    });
    expect(messageFilters).toContainEqual({
      table: 'messages',
      column: 'message_id',
      value: 'wamid.1',
    });
  });

  it('never touches broadcast recipients for a UAZAPI status', async () => {
    const { db, filters } = fakeDb({
      recipient: { id: 'r-1', status: 'sent' },
    });

    await processStatusUpdate({ db, event: event({ provider: 'uazapi' }) });

    expect(filters.some((f) => f.table === 'broadcast_recipients')).toBe(false);
  });

  it('mirrors a Meta status onto its broadcast recipient', async () => {
    const { db, writes } = fakeDb({ recipient: { id: 'r-1', status: 'sent' } });

    await processStatusUpdate({ db, event: event({ status: 'read' }) });

    expect(writes).toContainEqual({
      table: 'broadcast_recipients',
      patch: { status: 'read', read_at: '2026-09-15T12:00:00.000Z' },
    });
  });

  it('refuses to walk a recipient back down the status ladder', async () => {
    const { db, writes } = fakeDb({ recipient: { id: 'r-1', status: 'read' } });

    await processStatusUpdate({ db, event: event({ status: 'delivered' }) });

    expect(writes.some((w) => w.table === 'broadcast_recipients')).toBe(false);
  });

  it('stores a numeric failure code and the reason text', async () => {
    const { db, writes } = fakeDb();

    await processStatusUpdate({
      db,
      event: event({
        status: 'failed',
        failure: { code: '131049', title: 'Not delivered', details: 'why' },
      }),
    });

    expect(writes[0]).toEqual({
      table: 'messages',
      patch: {
        status: 'failed',
        error_code: 131049,
        error_title: 'Not delivered',
        error_details: 'why',
      },
    });
  });

  it('drops a non-numeric provider code rather than breaking the insert', async () => {
    const { db, writes } = fakeDb();

    await processStatusUpdate({
      db,
      event: event({
        provider: 'uazapi',
        status: 'failed',
        failure: {
          code: 'WHATSAPP_REACHOUT_TIMELOCK',
          title: 'Rejected',
          details: null,
        },
      }),
    });

    // `messages.error_code` is an INTEGER column.
    expect(writes[0].patch).toMatchObject({
      error_code: null,
      error_title: 'Rejected',
    });
  });

  it('fans the change out to the owning account', async () => {
    const { db } = fakeDb({
      messageRow: {
        conversation_id: 'cv-1',
        conversations: { account_id: 'acc-1' },
      },
    });

    await processStatusUpdate({ db, event: event() });

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.status_updated',
      {
        whatsapp_message_id: 'wamid.1',
        conversation_id: 'cv-1',
        status: 'delivered',
      }
    );
  });

  it('stays quiet when no stored message matches', async () => {
    const { db } = fakeDb();

    await processStatusUpdate({ db, event: event() });

    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('isValidStatusTransition', () => {
  it('only moves forward along the ladder', () => {
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true);
    expect(isValidStatusTransition('read', 'delivered')).toBe(false);
    expect(isValidStatusTransition('delivered', 'delivered')).toBe(false);
  });

  it('accepts failure only before delivery, and treats it as terminal', () => {
    expect(isValidStatusTransition('sent', 'failed')).toBe(true);
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false);
    expect(isValidStatusTransition('failed', 'read')).toBe(false);
  });
});
