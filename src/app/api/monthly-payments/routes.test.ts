import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listReminders: vi.fn(),
  listRecipientContacts: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  setReminderEnabled: vi.fn(),
  softDeleteReminder: vi.fn(),
  listDeliveries: vi.fn(),
  getReminder: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: () => Response.json({ error: 'Acesso negado' }, { status: 403 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.from }),
}));
vi.mock('@/lib/monthly-payments/repository', () => ({
  MonthlyPaymentNotFoundError: class extends Error {},
  MonthlyPaymentRepositoryError: class extends Error {},
  listReminders: mocks.listReminders,
  listRecipientContacts: mocks.listRecipientContacts,
  createReminder: mocks.createReminder,
  updateReminder: mocks.updateReminder,
  setReminderEnabled: mocks.setReminderEnabled,
  softDeleteReminder: mocks.softDeleteReminder,
  listDeliveries: mocks.listDeliveries,
  getReminder: mocks.getReminder,
}));

import { GET, POST } from './route';
import { DELETE, PUT } from './[id]/route';
import { GET as GET_DELIVERIES } from './[id]/deliveries/route';

const context = { accountId: 'account-a', userId: 'user-a', role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(context);
  mocks.listReminders.mockResolvedValue([]);
  mocks.listRecipientContacts.mockResolvedValue([]);
  mocks.createReminder.mockResolvedValue({ id: 'reminder-1' });
  mocks.setReminderEnabled.mockResolvedValue({ id: 'reminder-1', enabled: false });
  mocks.softDeleteReminder.mockResolvedValue(undefined);
  mocks.listDeliveries.mockResolvedValue([]);
  mocks.from.mockReturnValue({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { provider: 'uazapi' }, error: null }) }),
    }),
  });
});

describe('monthly payments routes', () => {
  it('rejects callers below admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await GET()).status).toBe(403);
  });

  it('lists account reminders, contact choices and provider', async () => {
    mocks.listReminders.mockResolvedValue([{ id: 'r-1' }]);
    mocks.listRecipientContacts.mockResolvedValue([{ id: 'c-1', name: 'João', phone: '5511' }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reminders: [{ id: 'r-1' }],
      contacts: [{ id: 'c-1', name: 'João', phone: '5511' }],
      whatsapp_provider: 'uazapi',
    });
    expect(mocks.listReminders).toHaveBeenCalledWith(expect.anything(), 'account-a');
  });

  it('returns 400 for invalid create input', async () => {
    const response = await POST(
      new Request('http://localhost/api/monthly-payments', {
        method: 'POST',
        body: JSON.stringify({ amount_cents: 0 }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('creates a validated reminder', async () => {
    const response = await POST(
      new Request('http://localhost/api/monthly-payments', {
        method: 'POST',
        body: JSON.stringify({
          recipient_kind: 'contact',
          contact_id: 'c-1',
          amount_cents: 50_000,
          send_day: 10,
          send_time: '09:00',
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createReminder).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'account-a', userId: 'user-a' },
      expect.objectContaining({ amountCents: 50_000 }),
    );
  });

  it('pauses an account-scoped reminder', async () => {
    const response = await PUT(
      new Request('http://localhost/api/monthly-payments/r-1', {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: 'r-1' }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setReminderEnabled).toHaveBeenCalledWith(
      expect.anything(),
      'account-a',
      'r-1',
      false,
    );
  });

  it('soft deletes and lists history inside the account', async () => {
    expect(
      (await DELETE(new Request('http://localhost'), { params: Promise.resolve({ id: 'r-1' }) })).status,
    ).toBe(200);
    expect(mocks.softDeleteReminder).toHaveBeenCalledWith(expect.anything(), 'account-a', 'r-1');

    const history = await GET_DELIVERIES(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'r-1' }),
    });
    expect(history.status).toBe(200);
    expect(mocks.listDeliveries).toHaveBeenCalledWith(expect.anything(), 'account-a', 'r-1');
  });
});
