import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  amountTextToCents,
  buildReminderPayload,
  MonthlyPaymentSummary,
} from './monthly-payments-client';

describe('monthly payments UI helpers', () => {
  it('parses Brazilian money text into integer cents', () => {
    expect(amountTextToCents('500,00')).toBe(50_000);
    expect(amountTextToCents('1.234,56')).toBe(123_456);
    expect(amountTextToCents('0')).toBeNull();
  });

  it('builds mutually exclusive contact and manual recipient payloads', () => {
    expect(buildReminderPayload({
      recipientKind: 'contact',
      contactId: 'contact-1',
      recipientName: '',
      recipientPhone: '',
      amountText: '500,00',
      sendDay: 10,
      sendTime: '09:00',
      enabled: true,
    })).toEqual({
      recipient_kind: 'contact',
      contact_id: 'contact-1',
      amount_cents: 50_000,
      send_day: 10,
      send_time: '09:00',
      enabled: true,
    });

    expect(buildReminderPayload({
      recipientKind: 'manual',
      contactId: '',
      recipientName: 'Maria',
      recipientPhone: '+5511999990000',
      amountText: '250,50',
      sendDay: 20,
      sendTime: '14:30',
      enabled: true,
    })).toMatchObject({
      recipient_kind: 'manual',
      recipient_name: 'Maria',
      recipient_phone: '+5511999990000',
      amount_cents: 25_050,
    });
  });
});

describe('MonthlyPaymentSummary', () => {
  it('surfaces recipient, amount, next send and last failure', () => {
    const html = renderToStaticMarkup(
      <MonthlyPaymentSummary
        reminder={{
          id: 'r-1',
          recipient_kind: 'manual',
          contact_id: null,
          recipient_name: 'João',
          recipient_phone: '5511999990000',
          amount_cents: 50_000,
          currency: 'BRL',
          send_day: 10,
          send_time: '09:00:00',
          enabled: true,
          next_scheduled_at: '2026-11-10T12:00:00.000Z',
          last_delivery: { status: 'failed', last_error: 'WhatsApp desconectado' },
        }}
        contactName={null}
      />,
    );

    expect(html).toContain('João');
    expect(html).toContain('R$ 500,00');
    expect(html).toContain('10/11/2026');
    expect(html).toContain('WhatsApp desconectado');
  });
});

