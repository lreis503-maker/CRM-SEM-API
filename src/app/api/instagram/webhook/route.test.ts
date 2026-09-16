import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// `after()` in production is fire-and-forget: the route returns its
// response without awaiting the callback. The real `next/server` mock
// below preserves that (POST does not await `after`'s return value),
// but the test still needs a deterministic way to know when the
// background DB work has settled before asserting on `tables`. We
// stash the callback's promise here so tests can explicitly await it
// — that's testing infrastructure only, not a change to route
// behaviour (POST itself never touches `afterState`).
const afterState = vi.hoisted(() => ({ promise: Promise.resolve() as Promise<unknown> }));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: (cb: () => Promise<void>) => {
      afterState.promise = cb();
      return afterState.promise;
    },
  };
});

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.META_APP_SECRET = 'test-app-secret';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

import { encrypt } from '@/lib/whatsapp/encryption';

const tables: Record<string, unknown[]> = {
  instagram_config: [],
  instagram_contacts: [],
  instagram_conversations: [],
  instagram_messages: [],
};

function resetTables() {
  tables.instagram_config = [
    {
      account_id: 'acc-1',
      ig_user_id: 'ig-user-1',
      page_access_token: encrypt('page-token'),
      verify_token: encrypt('verify-me'),
    },
  ];
  tables.instagram_contacts = [];
  tables.instagram_conversations = [];
  tables.instagram_messages = [];
}

// Minimal in-memory fake covering exactly the query shapes the route
// uses: select/eq/maybeSingle, insert/select/single, upsert/select.
function fakeAdminClient() {
  return {
    from(table: string) {
      const rows = () => tables[table];
      const builder = {
        _filters: [] as Array<[string, unknown]>,
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          builder._filters.push([col, val]);
          return builder;
        },
        maybeSingle: async () => {
          const match = rows().find((r) =>
            builder._filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val),
          );
          return { data: match ?? null, error: null };
        },
        // Real supabase-js query builders are themselves PromiseLike —
        // `await client.from(x).select(y)` resolves to `{ data, error }`
        // even with no terminal call chained on. The GET handler relies
        // on exactly that (it needs every config row, not a single
        // match), so the fake must support it too.
        then(
          resolve: (value: { data: unknown[]; error: null }) => void,
          reject?: (reason: unknown) => void,
        ) {
          const matches = rows().filter((r) =>
            builder._filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val),
          );
          Promise.resolve({ data: matches, error: null }).then(resolve, reject);
        },
        insert(row: Record<string, unknown>) {
          const withId = { id: crypto.randomUUID(), ...row };
          rows().push(withId);
          return {
            select: () => ({
              single: async () => ({ data: withId, error: null }),
            }),
          };
        },
        upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates?: boolean }) {
          const conflictCols = opts.onConflict.split(',');
          const existing = rows().find((r) =>
            conflictCols.every(
              (col) => (r as Record<string, unknown>)[col] === (row as Record<string, unknown>)[col],
            ),
          );
          if (existing && opts.ignoreDuplicates) {
            return { select: () => Promise.resolve({ data: [], error: null }) };
          }
          const withId = { id: crypto.randomUUID(), ...row };
          rows().push(withId);
          return { select: () => Promise.resolve({ data: [withId], error: null }) };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (col: string, val: unknown) => {
              const match = rows().find((r) => (r as Record<string, unknown>)[col] === val);
              if (match) Object.assign(match, patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/mirrored.jpg' } }),
      }),
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => fakeAdminClient(),
}));

vi.mock('@/lib/instagram/graph-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instagram/graph-api')>(
    '@/lib/instagram/graph-api',
  );
  return {
    ...actual,
    fetchInstagramProfile: vi.fn().mockResolvedValue({ name: 'Jane', username: 'jane' }),
    markInstagramSeen: vi.fn().mockResolvedValue(undefined),
  };
});

import { GET, POST } from './route';

function signedRequest(body: unknown) {
  const raw = JSON.stringify(body);
  const signature =
    'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
  return new Request('http://localhost/api/instagram/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': signature },
  });
}

beforeEach(() => {
  resetTables();
});

describe('GET /api/instagram/webhook', () => {
  it('returns the challenge when the verify token matches', async () => {
    const url =
      'http://localhost/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=verify-me';
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('123');
  });

  it('rejects an unmatched verify token', async () => {
    const url =
      'http://localhost/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong';
    const res = await GET(new Request(url));
    expect(res.status).toBe(403);
  });

  it('rejects a request missing parameters', async () => {
    const res = await GET(new Request('http://localhost/api/instagram/webhook'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/instagram/webhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/webhook', {
        method: 'POST',
        body: JSON.stringify({ object: 'instagram', entry: [] }),
        headers: { 'x-hub-signature-256': 'sha256=wrong' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('stores an inbound text message, creating the contact and conversation', async () => {
    const res = await POST(
      signedRequest({
        object: 'instagram',
        entry: [
          {
            id: 'ig-user-1',
            time: 1700000000000,
            messaging: [
              {
                sender: { id: 'igsid-1' },
                recipient: { id: 'ig-user-1' },
                timestamp: 1700000000000,
                message: { mid: 'mid-1', text: 'Olá!' },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    // DB work happens in the after() callback, which runs in the
    // background relative to the response — wait for it to settle
    // before inspecting the fake tables.
    await afterState.promise;
    expect(tables.instagram_contacts).toHaveLength(1);
    expect(tables.instagram_conversations).toHaveLength(1);
    expect(tables.instagram_messages).toHaveLength(1);
    expect(tables.instagram_messages[0]).toMatchObject({
      content_text: 'Olá!',
      content_type: 'text',
      sender_type: 'customer',
    });
  });

  it('is idempotent for a redelivered message id', async () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-user-1',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'igsid-1' },
              recipient: { id: 'ig-user-1' },
              timestamp: 1700000000000,
              message: { mid: 'mid-1', text: 'Olá!' },
            },
          ],
        },
      ],
    };
    await POST(signedRequest(payload));
    await afterState.promise;
    await POST(signedRequest(payload));
    await afterState.promise;
    expect(tables.instagram_messages).toHaveLength(1);
  });
});
