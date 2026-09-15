import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetQuarantinePurgeClock,
  fingerprintWebhookPayload,
  purgeExpiredWebhookQuarantine,
  quarantineWebhookFailure,
  sanitizeWebhookPayload,
} from './webhook-quarantine';
import type { InboundDatabase } from './types';

interface Write {
  table: string;
  op: 'insert' | 'update' | 'delete';
  row?: Record<string, unknown>;
}

function fakeDb(existing: Record<string, unknown> | null = null) {
  const writes: Write[] = [];
  const filters: Array<{ column: string; value: unknown }> = [];

  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        },
        lt: (column: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        },
        maybeSingle: async () => ({ data: existing, error: null }),
        insert: (row: Record<string, unknown>) => {
          writes.push({ table, op: 'insert', row });
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          writes.push({ table, op: 'update', row });
          return builder;
        },
        delete: () => {
          writes.push({ table, op: 'delete' });
          return builder;
        },
        then: (resolve: (r: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return builder;
    },
  };

  return { db: db as unknown as InboundDatabase, writes, filters };
}

const INPUT = {
  accountId: 'acc-1',
  configId: 'cfg-1',
  provider: 'uazapi' as const,
  reasonCode: 'unknown_message_type',
  eventName: 'messages',
};

beforeEach(() => {
  __resetQuarantinePurgeClock();
});

describe('sanitizeWebhookPayload', () => {
  it('removes every credential-shaped key', () => {
    const sanitized = sanitizeWebhookPayload({
      event: 'messages',
      token: 'instance-token',
      data: {
        qrcode: 'iVBORw0KGgo',
        base64Data: 'AAAA',
        authorization: 'Bearer x',
        text: 'oi',
      },
    }) as { token: string; data: Record<string, unknown> };

    expect(sanitized.token).toBe('[redacted]');
    expect(sanitized.data.qrcode).toBe('[redacted]');
    expect(sanitized.data.base64Data).toBe('[redacted]');
    expect(sanitized.data.authorization).toBe('[redacted]');
    expect(sanitized.data.text).toBe('oi');
    expect(JSON.stringify(sanitized)).not.toContain('instance-token');
  });

  it('drops an inline media payload', () => {
    const sanitized = sanitizeWebhookPayload({
      data: { file: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' },
    }) as { data: { file: string } };

    expect(sanitized.data.file).toBe('[redacted]');
  });

  it('keeps the sample under the storage cap', () => {
    const sanitized = sanitizeWebhookPayload({
      data: { blobs: Array.from({ length: 5000 }, () => 'x'.repeat(500)) },
    });

    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('survives a body that is not an object', () => {
    expect(sanitizeWebhookPayload('plain')).toBe('plain');
    expect(sanitizeWebhookPayload(null)).toBeNull();
  });
});

describe('fingerprintWebhookPayload', () => {
  it('is a stable sha-256 of the raw body', () => {
    const a = fingerprintWebhookPayload('{"event":"messages"}');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintWebhookPayload('{"event":"messages"}')).toBe(a);
    expect(fingerprintWebhookPayload('{"event":"other"}')).not.toBe(a);
  });
});

describe('quarantineWebhookFailure', () => {
  it('stores a redacted sample the first time a shape is seen', async () => {
    const { db, writes } = fakeDb(null);

    await quarantineWebhookFailure({
      db,
      ...INPUT,
      rawBody: '{"event":"messages","token":"instance-token"}',
      payload: { event: 'messages', token: 'instance-token' },
    });

    const insert = writes.find((w) => w.op === 'insert');
    expect(insert?.table).toBe('whatsapp_webhook_quarantine');
    expect(insert?.row).toMatchObject({
      account_id: 'acc-1',
      config_id: 'cfg-1',
      provider: 'uazapi',
      reason_code: 'unknown_message_type',
      event_name: 'messages',
      occurrence_count: 1,
    });
    expect(insert?.row?.payload_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(insert?.row?.payload)).not.toContain(
      'instance-token'
    );
  });

  it('expires the record seven days after it was seen', async () => {
    const { db, writes } = fakeDb(null);
    const now = new Date('2026-09-15T12:00:00.000Z');

    await quarantineWebhookFailure({
      db,
      ...INPUT,
      rawBody: '{}',
      payload: {},
      now: () => now,
    });

    expect(writes[0].row?.expires_at).toBe('2026-09-22T12:00:00.000Z');
  });

  it('counts a repeat of the same shape instead of storing it again', async () => {
    const { db, writes } = fakeDb({ id: 'q-1', occurrence_count: 3 });
    const now = new Date('2026-09-15T12:00:00.000Z');

    await quarantineWebhookFailure({
      db,
      ...INPUT,
      rawBody: '{}',
      payload: {},
      now: () => now,
    });

    expect(writes.some((w) => w.op === 'insert')).toBe(false);
    expect(writes[0]).toMatchObject({
      op: 'update',
      row: {
        occurrence_count: 4,
        last_seen_at: '2026-09-15T12:00:00.000Z',
        // Renewed, so a shape that keeps arriving keeps its record.
        expires_at: '2026-09-22T12:00:00.000Z',
      },
    });
  });

  it('never lets a quarantine failure break the caller', async () => {
    const db = {
      from: () => {
        throw new Error('database down');
      },
    } as unknown as InboundDatabase;

    await expect(
      quarantineWebhookFailure({ db, ...INPUT, rawBody: '{}', payload: {} })
    ).resolves.toBeUndefined();
  });
});

describe('purgeExpiredWebhookQuarantine', () => {
  it('deletes only rows that have expired', async () => {
    const { db, writes, filters } = fakeDb();
    const now = new Date('2026-09-15T12:00:00.000Z');

    await purgeExpiredWebhookQuarantine(db, () => now);

    expect(writes).toEqual([
      { table: 'whatsapp_webhook_quarantine', op: 'delete' },
    ]);
    expect(filters).toContainEqual({
      column: 'expires_at',
      value: '2026-09-15T12:00:00.000Z',
    });
  });

  it('runs at most once a day, so a busy webhook does not hammer it', async () => {
    const { db, writes } = fakeDb();
    const start = new Date('2026-09-15T12:00:00.000Z');

    await purgeExpiredWebhookQuarantine(db, () => start);
    await purgeExpiredWebhookQuarantine(db, () => start);
    await purgeExpiredWebhookQuarantine(
      db,
      () => new Date('2026-09-15T20:00:00.000Z')
    );
    expect(writes).toHaveLength(1);

    await purgeExpiredWebhookQuarantine(
      db,
      () => new Date('2026-09-16T13:00:00.000Z')
    );
    expect(writes).toHaveLength(2);
  });

  it('never lets a purge failure break the caller', async () => {
    const db = {
      from: () => {
        throw new Error('database down');
      },
    } as unknown as InboundDatabase;

    await expect(purgeExpiredWebhookQuarantine(db)).resolves.toBeUndefined();
  });
});
