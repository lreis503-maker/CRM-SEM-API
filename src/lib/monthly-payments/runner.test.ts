import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  runMonthlyPaymentDeliveries,
  sendMonthlyPaymentMessage,
  type ClaimedMonthlyPayment,
} from './runner';

const manualClaim: ClaimedMonthlyPayment = {
  delivery: {
    id: 'delivery-1',
    reminder_id: 'reminder-1',
    account_id: 'account-a',
    competence: '2026-10-01',
    scheduled_for: '2026-10-20T12:00:00.000Z',
    status: 'processing',
    attempts: 1,
    processing_at: '2026-10-20T12:00:00.000Z',
    next_attempt_at: null,
    sent_at: null,
    recipient_name: null,
    recipient_phone: null,
    message: null,
    last_error: null,
    updated_at: '2026-10-20T12:00:00.000Z',
  },
  reminder: {
    id: 'reminder-1',
    account_id: 'account-a',
    recipient_kind: 'manual',
    contact_id: null,
    recipient_name: 'Maria',
    recipient_phone: '5511999990000',
    amount_cents: 50_000,
    currency: 'BRL',
    send_day: 20,
    send_time: '09:00:00',
    timezone: 'America/Sao_Paulo',
    enabled: true,
    starts_at: '2026-10-01T00:00:00.000Z',
    deleted_at: null,
    created_by: 'user-a',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  },
};

function updateDb() {
  const updates: unknown[] = [];
  const filters: unknown[] = [];
  const q = {
    update: (payload: unknown) => {
      updates.push(payload);
      return q;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return q;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve),
  };
  return {
    db: { from: () => q } as unknown as SupabaseClient,
    updates,
    filters,
  };
}

describe('sendMonthlyPaymentMessage', () => {
  it('sends a CRM contact through a conversation so it appears in the inbox', async () => {
    const engineSend = vi.fn(async () => ({ whatsapp_message_id: 'wamid-1' }));
    const reminder = {
      ...manualClaim.reminder,
      recipient_kind: 'contact' as const,
      contact_id: 'contact-1',
      recipient_name: null,
      recipient_phone: null,
    };

    const result = await sendMonthlyPaymentMessage(
      {
        db: {} as SupabaseClient,
        reminder,
        competence: '2026-10-01',
        trackId: 'monthly:delivery-1',
      },
      {
        loadContact: async () => ({ id: 'contact-1', name: 'João', phone: '5511888880000' }),
        resolveConversation: async () => ({
          conversationId: 'conversation-1',
          contactId: 'contact-1',
          userId: 'owner-user',
        }),
        engineSend,
      },
    );

    expect(engineSend).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      userId: 'owner-user',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
    }));
    expect(result).toMatchObject({
      providerMessageId: 'wamid-1',
      recipientName: 'João',
      recipientPhone: '5511888880000',
    });
  });

  it('sends a manual number directly through the active provider', async () => {
    const directSend = vi.fn(async () => ({ externalMessageId: 'uazapi-1' }));
    const result = await sendMonthlyPaymentMessage(
      {
        db: {} as SupabaseClient,
        reminder: manualClaim.reminder,
        competence: '2026-10-01',
        trackId: 'monthly:delivery-1',
      },
      { directSend },
    );

    expect(directSend).toHaveBeenCalledWith(
      'account-a',
      '5511999990000',
      expect.stringContaining('mensalidade referente a outubro'),
      'monthly:delivery-1',
    );
    expect(result.providerMessageId).toBe('uazapi-1');
  });

  it('fails visibly when the selected contact no longer exists', async () => {
    await expect(
      sendMonthlyPaymentMessage(
        {
          db: {} as SupabaseClient,
          reminder: {
            ...manualClaim.reminder,
            recipient_kind: 'contact',
            contact_id: 'deleted-contact',
          },
          competence: '2026-10-01',
          trackId: 'monthly:delivery-1',
        },
        { loadContact: async () => null },
      ),
    ).rejects.toThrow('não existe mais');
  });
});

describe('runMonthlyPaymentDeliveries', () => {
  it('records a successful delivery with the effective recipient and message', async () => {
    const { db, updates } = updateDb();
    const send = vi.fn(async () => ({
      providerMessageId: 'message-1',
      recipientName: 'Maria',
      recipientPhone: '5511999990000',
      message: 'texto final',
    }));

    await expect(
      runMonthlyPaymentDeliveries(db, { now: new Date('2026-10-20T12:00:00.000Z') }, {
        claim: async () => [manualClaim],
        send,
      }),
    ).resolves.toEqual({ claimed: 1, sent: 1, failed: 0 });

    expect(updates.at(-1)).toMatchObject({
      status: 'sent',
      recipient_name: 'Maria',
      recipient_phone: '5511999990000',
      message: 'texto final',
      provider_message_id: 'message-1',
    });
  });

  it('records a safe failure and schedules an hourly retry', async () => {
    const { db, updates } = updateDb();
    const now = new Date('2026-10-20T12:00:00.000Z');

    const result = await runMonthlyPaymentDeliveries(db, { now }, {
      claim: async () => [manualClaim],
      send: async () => {
        throw new Error(`token-super-secreto ${'x'.repeat(600)}`);
      },
    });

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(updates.at(-1)).toMatchObject({
      status: 'failed',
      next_attempt_at: '2026-10-20T13:00:00.000Z',
    });
    expect(String((updates.at(-1) as Record<string, unknown>).last_error)).toHaveLength(500);
  });
});

