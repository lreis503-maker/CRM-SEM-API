import { describe, expect, it } from 'vitest';

import {
  buildClientMessage,
  buildInternalMessage,
  formatMoney,
} from './alert-message';

const CONTEXT = {
  accountLabel: 'Loja da Ana — Vendas',
  externalAccountId: '1234567890',
  contactName: 'Ana Paula Souza',
  currency: 'BRL',
  availableCents: 8750,
  thresholdCents: 10000,
  reasonCode: 'below_threshold',
};

describe('formatMoney', () => {
  it('mostra os centavos, ao contrário do formatador do painel', () => {
    expect(formatMoney(8750, 'BRL')).toMatch(/87,50/);
  });

  it('não quebra com um código de moeda inválido vindo do banco', () => {
    expect(formatMoney(8750, 'Reais')).toContain('Reais');
  });
});

describe('buildClientMessage', () => {
  it('chama o cliente pelo primeiro nome', () => {
    expect(buildClientMessage('low_balance', CONTEXT)).toMatch(/^Oi, Ana!/);
  });

  it('funciona sem nome de contato', () => {
    expect(
      buildClientMessage('low_balance', { ...CONTEXT, contactName: null })
    ).toMatch(/^Oi!/);
  });

  it('diz o limite, e só o limite', () => {
    const text = buildClientMessage('low_balance', CONTEXT);
    expect(text).toMatch(/100,00/);
    expect(text).toContain('Loja da Ana — Vendas');
  });

  it('nunca revela o saldo exato ao cliente', () => {
    // O saldo do contexto é R$ 87,50. Ele pertence à cópia interna.
    for (const kind of ['low_balance', 'balance_recovered'] as const) {
      expect(buildClientMessage(kind, CONTEXT)).not.toMatch(/87,50/);
    }
  });

  it('nunca expõe o id da conta de anúncio para o cliente', () => {
    for (const kind of [
      'low_balance',
      'payment_stopped',
      'balance_recovered',
      'payment_recovered',
    ] as const) {
      expect(buildClientMessage(kind, CONTEXT)).not.toContain('1234567890');
    }
  });

  it('explica cada motivo de parada em linguagem de cliente', () => {
    const semCartao = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'no_funding_source',
    });
    expect(semCartao).toContain('sem forma de pagamento');
    expect(semCartao).not.toContain('account_status');

    const fatura = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'unsettled',
    });
    expect(fatura).toContain('fatura em aberto');
  });

  it('não inventa explicação para um motivo desconhecido', () => {
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'motivo_novo_da_meta',
    });
    expect(text).toContain('a cobrança da conta de anúncios foi interrompida');
    expect(text).not.toContain('motivo_novo_da_meta');
  });

  it('sai igual mesmo sem saldo lido, sem escrever "null"', () => {
    const semSaldo = buildClientMessage('low_balance', {
      ...CONTEXT,
      availableCents: null,
    });
    expect(semSaldo).toBe(buildClientMessage('low_balance', CONTEXT));
    expect(semSaldo).not.toContain('null');
    expect(semSaldo).not.toContain('NaN');
  });
});

describe('buildInternalMessage', () => {
  it('traz id da conta e números para a equipe agir', () => {
    const text = buildInternalMessage('low_balance', CONTEXT);
    expect(text).toContain('act_1234567890');
    expect(text).toMatch(/87,50/);
    expect(text).toContain('Ana Paula Souza');
  });

  it('avisa quando não há contato vinculado', () => {
    expect(
      buildInternalMessage('payment_stopped', { ...CONTEXT, contactName: null })
    ).toContain('sem contato vinculado');
  });

  it('nomeia o código técnico do problema', () => {
    expect(
      buildInternalMessage('payment_stopped', {
        ...CONTEXT,
        reasonCode: 'unsettled',
      })
    ).toContain('account_status 3');
  });

  it('marca um motivo fora do mapa em vez de silenciar', () => {
    expect(
      buildInternalMessage('payment_stopped', {
        ...CONTEXT,
        reasonCode: 'motivo_novo_da_meta',
      })
    ).toContain('motivo_novo_da_meta');
  });
});
