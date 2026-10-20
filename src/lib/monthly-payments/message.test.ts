import { describe, expect, it } from 'vitest';

import { buildMonthlyPaymentMessage } from './message';

describe('buildMonthlyPaymentMessage', () => {
  it('builds the approved automatic monthly payment message', () => {
    expect(
      buildMonthlyPaymentMessage({
        recipientName: 'João',
        competence: '2026-10-01',
        amountCents: 50_000,
        currency: 'BRL',
      }),
    ).toBe(
      '🤖 *Mensagem automática*\n' +
        'Olá, João! A mensalidade referente a outubro está no valor de R$ 500,00.\n' +
        'Quando for realizar o pagamento, me chame por aqui para eu enviar o Pix.',
    );
  });
});

