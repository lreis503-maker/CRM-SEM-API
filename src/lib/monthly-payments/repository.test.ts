import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createReminder,
  listReminders,
  setReminderEnabled,
  softDeleteReminder,
} from './repository';

function query(result: { data?: unknown; error?: unknown } = { data: null, error: null }) {
  const filters: Array<[string, string, unknown]> = [];
  let payload: unknown;
  const q: Record<string, unknown> = {
    select: vi.fn(() => q),
    insert: vi.fn((value: unknown) => {
      payload = value;
      return q;
    }),
    update: vi.fn((value: unknown) => {
      payload = value;
      return q;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push(['eq', column, value]);
      return q;
    }),
    is: vi.fn((column: string, value: unknown) => {
      filters.push(['is', column, value]);
      return q;
    }),
    order: vi.fn(() => q),
    limit: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
    single: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve),
  };
  return { q, filters, payload: () => payload };
}

describe('monthly payment repository', () => {
  it('lists only non-deleted reminders from the requested account', async () => {
    const reminders = query({ data: [] });
    const db = { from: vi.fn(() => reminders.q) } as unknown as SupabaseClient;

    await listReminders(db, 'account-a');

    expect(reminders.filters).toContainEqual(['eq', 'account_id', 'account-a']);
    expect(reminders.filters).toContainEqual(['is', 'deleted_at', null]);
  });

  it('verifies a CRM contact belongs to the account before creating', async () => {
    const contact = query({ data: { id: 'contact-1' } });
    const inserted = query({ data: { id: 'reminder-1' } });
    const db = {
      from: vi.fn((table: string) => (table === 'contacts' ? contact.q : inserted.q)),
    } as unknown as SupabaseClient;

    await createReminder(
      db,
      { accountId: 'account-a', userId: 'user-a' },
      {
        recipient: { kind: 'contact', contactId: 'contact-1' },
        amountCents: 50_000,
        sendDay: 10,
        sendTime: '09:00',
        enabled: true,
      },
      new Date('2026-10-20T12:00:00.000Z'),
    );

    expect(contact.filters).toContainEqual(['eq', 'account_id', 'account-a']);
    expect(inserted.payload()).toMatchObject({
      account_id: 'account-a',
      created_by: 'user-a',
      recipient_kind: 'contact',
      contact_id: 'contact-1',
      starts_at: '2026-10-20T12:00:00.000Z',
    });
  });

  it('rejects a contact from another account', async () => {
    const contact = query({ data: null });
    const db = { from: vi.fn(() => contact.q) } as unknown as SupabaseClient;

    await expect(
      createReminder(db, { accountId: 'account-a', userId: 'user-a' }, {
        recipient: { kind: 'contact', contactId: 'foreign-contact' },
        amountCents: 10_000,
        sendDay: 1,
        sendTime: '09:00',
        enabled: true,
      }),
    ).rejects.toThrow('contato');
  });

  it('reactivation refreshes starts_at and remains account scoped', async () => {
    const existing = query({ data: { id: 'r-1', enabled: false } });
    const updated = query({ data: { id: 'r-1', enabled: true } });
    const db = {
      from: vi.fn(() => (db.from as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1
        ? existing.q
        : updated.q),
    } as unknown as SupabaseClient;
    const now = new Date('2026-10-20T12:01:00.000Z');

    await setReminderEnabled(db, 'account-a', 'r-1', true, now);

    expect(updated.filters).toContainEqual(['eq', 'account_id', 'account-a']);
    expect(updated.payload()).toMatchObject({ enabled: true, starts_at: now.toISOString() });
  });

  it('soft deletes and disables without removing delivery history', async () => {
    const updated = query({ data: { id: 'r-1' } });
    const db = { from: vi.fn(() => updated.q) } as unknown as SupabaseClient;
    const now = new Date('2026-10-20T12:00:00.000Z');

    await softDeleteReminder(db, 'account-a', 'r-1', now);

    expect(updated.filters).toContainEqual(['eq', 'account_id', 'account-a']);
    expect(updated.payload()).toMatchObject({
      enabled: false,
      deleted_at: now.toISOString(),
    });
  });
});

