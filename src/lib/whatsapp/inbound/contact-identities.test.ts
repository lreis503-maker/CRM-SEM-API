import { beforeEach, describe, expect, it, vi } from 'vitest';

const isUniqueViolation = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../contacts/dedupe', () => ({ isUniqueViolation }));

import {
  attachExternalIdentity,
  findContactIdByExternalIdentity,
} from './contact-identities';
import type { InboundDatabase } from './types';

interface Recorded {
  op: 'insert' | 'update';
  row: Record<string, unknown>;
}

function fakeDb(
  options: {
    existing?: Record<string, unknown> | null;
    insertError?: unknown;
  } = {}
) {
  const writes: Recorded[] = [];
  const filters: Array<{ column: string; value: unknown }> = [];
  let reads = 0;

  const db = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        },
        maybeSingle: async () => {
          reads += 1;
          return { data: options.existing ?? null, error: null };
        },
        insert: (row: Record<string, unknown>) => {
          writes.push({ op: 'insert', row });
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          writes.push({ op: 'update', row });
          return builder;
        },
        then: (resolve: (r: { data: null; error: unknown }) => unknown) =>
          resolve({ data: null, error: options.insertError ?? null }),
      };
      return builder;
    },
  };

  return {
    db: db as unknown as InboundDatabase,
    writes,
    filters,
    reads: () => reads,
  };
}

const IDENTITY = {
  accountId: 'acc-1',
  provider: 'uazapi' as const,
  externalId: '182736@lid',
  kind: 'lid' as const,
};

beforeEach(() => {
  isUniqueViolation.mockReset();
  isUniqueViolation.mockReturnValue(false);
});

describe('findContactIdByExternalIdentity', () => {
  it('scopes the lookup to the account, provider and identifier', async () => {
    const { db, filters } = fakeDb({ existing: { contact_id: 'ct-9' } });

    await expect(findContactIdByExternalIdentity(db, IDENTITY)).resolves.toBe(
      'ct-9'
    );
    expect(filters).toEqual([
      { column: 'account_id', value: 'acc-1' },
      { column: 'provider', value: 'uazapi' },
      { column: 'external_id', value: '182736@lid' },
    ]);
  });

  it('returns null when the identifier has never been seen', async () => {
    const { db } = fakeDb({ existing: null });
    await expect(
      findContactIdByExternalIdentity(db, IDENTITY)
    ).resolves.toBeNull();
  });
});

describe('attachExternalIdentity', () => {
  it('links a new identifier to the contact', async () => {
    const { db, writes } = fakeDb({ existing: null });

    await expect(attachExternalIdentity(db, IDENTITY, 'ct-1')).resolves.toBe(
      'ct-1'
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      op: 'insert',
      row: {
        account_id: 'acc-1',
        contact_id: 'ct-1',
        provider: 'uazapi',
        external_id: '182736@lid',
        kind: 'lid',
      },
    });
  });

  it('refreshes rather than duplicating an identifier already linked', async () => {
    const { db, writes } = fakeDb({
      existing: { id: 'wi-1', contact_id: 'ct-7' },
    });

    // The identifier already belongs to ct-7, so that contact wins — the
    // caller must not steal it for the contact it happened to resolve.
    await expect(attachExternalIdentity(db, IDENTITY, 'ct-1')).resolves.toBe(
      'ct-7'
    );
    expect(writes).toEqual([
      { op: 'update', row: { last_seen_at: expect.any(String) } },
    ]);
  });

  it('re-reads the winning row when a concurrent delivery claimed it', async () => {
    isUniqueViolation.mockReturnValue(true);
    let call = 0;
    const db = {
      from() {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => {
            call += 1;
            // First read: nothing linked yet. Second read, after the
            // insert lost the race: the winner.
            return {
              data: call === 1 ? null : { contact_id: 'ct-race' },
              error: null,
            };
          },
          insert: () => builder,
          update: () => builder,
          then: (resolve: (r: { data: null; error: unknown }) => unknown) =>
            resolve({ data: null, error: { code: '23505' } }),
        };
        return builder;
      },
    } as unknown as InboundDatabase;

    await expect(attachExternalIdentity(db, IDENTITY, 'ct-1')).resolves.toBe(
      'ct-race'
    );
  });

  it('keeps the resolved contact when the insert fails for another reason', async () => {
    const { db } = fakeDb({
      existing: null,
      insertError: { message: 'storage down' },
    });

    await expect(attachExternalIdentity(db, IDENTITY, 'ct-1')).resolves.toBe(
      'ct-1'
    );
  });
});
