import { describe, expect, it } from 'vitest';

import { parseReminderInput } from './validate';

const base = { amount_cents: 50_000, send_day: 10, send_time: '09:00' };

describe('parseReminderInput', () => {
  it('accepts a CRM contact recipient', () => {
    expect(
      parseReminderInput({ ...base, recipient_kind: 'contact', contact_id: 'contact-1' }),
    ).toEqual({
      recipient: { kind: 'contact', contactId: 'contact-1' },
      amountCents: 50_000,
      sendDay: 10,
      sendTime: '09:00',
      enabled: true,
    });
  });

  it('accepts and normalizes a manual recipient', () => {
    expect(
      parseReminderInput({
        ...base,
        recipient_kind: 'manual',
        recipient_name: '  Maria  ',
        recipient_phone: '+55 (11) 99999-0000',
        enabled: false,
      }),
    ).toEqual({
      recipient: { kind: 'manual', name: 'Maria', phone: '5511999990000' },
      amountCents: 50_000,
      sendDay: 10,
      sendTime: '09:00',
      enabled: false,
    });
  });

  it.each([
    [{ ...base, recipient_kind: 'manual', recipient_phone: '+5511999990000' }, 'nome'],
    [{ ...base, recipient_kind: 'manual', recipient_name: 'Maria', recipient_phone: '123' }, 'telefone'],
    [{ ...base, recipient_kind: 'contact', contact_id: '', amount_cents: 50_000 }, 'contato'],
    [{ ...base, recipient_kind: 'contact', contact_id: 'c', amount_cents: 0 }, 'valor'],
    [{ ...base, recipient_kind: 'contact', contact_id: 'c', amount_cents: -1 }, 'valor'],
    [{ ...base, recipient_kind: 'contact', contact_id: 'c', amount_cents: 500.5 }, 'centavos'],
    [{ ...base, recipient_kind: 'contact', contact_id: 'c', send_day: 32 }, 'dia'],
    [{ ...base, recipient_kind: 'contact', contact_id: 'c', send_time: '9h' }, 'horário'],
  ])('rejects invalid input %#', (input, message) => {
    expect(() => parseReminderInput(input)).toThrow(message);
  });
});

