import { parseInternalPhone } from '@/lib/ads/internal-phone';

import type { ReminderInput } from './types';

export class ReminderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderValidationError';
  }
}

export function parseReminderInput(raw: unknown): ReminderInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReminderValidationError('Dados da mensalidade inválidos');
  }
  const body = raw as Record<string, unknown>;
  const amountCents = body.amount_cents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    throw new ReminderValidationError('O valor precisa usar centavos inteiros');
  }
  if (amountCents <= 0) throw new ReminderValidationError('O valor precisa ser maior que zero');

  const sendDay = body.send_day;
  if (typeof sendDay !== 'number' || !Number.isInteger(sendDay) || sendDay < 1 || sendDay > 31) {
    throw new ReminderValidationError('O dia precisa estar entre 1 e 31');
  }
  const sendTime = typeof body.send_time === 'string' ? body.send_time.trim() : '';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
    throw new ReminderValidationError('O horário é inválido');
  }

  let recipient: ReminderInput['recipient'];
  if (body.recipient_kind === 'contact') {
    const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
    if (!contactId) throw new ReminderValidationError('Escolha um contato');
    recipient = { kind: 'contact', contactId };
  } else if (body.recipient_kind === 'manual') {
    const name = typeof body.recipient_name === 'string' ? body.recipient_name.trim() : '';
    if (!name) throw new ReminderValidationError('Informe o nome do destinatário');
    const phone = parseInternalPhone(body.recipient_phone);
    if (!phone || phone === 'invalid') {
      throw new ReminderValidationError('Informe um telefone internacional válido');
    }
    recipient = { kind: 'manual', name, phone };
  } else {
    throw new ReminderValidationError('Escolha o tipo de destinatário');
  }

  return {
    recipient,
    amountCents,
    sendDay,
    sendTime,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
  };
}

