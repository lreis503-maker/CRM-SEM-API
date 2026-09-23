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
  it('avisa que é mensagem automática, em toda mensagem', () => {
    // Chega no mesmo número em que a pessoa fala com a equipe; sem o
    // aviso, um "ok, obrigada" ficaria sem resposta e pareceria descaso.
    for (const kind of [
      'low_balance',
      'payment_stopped',
      'balance_recovered',
      'payment_recovered',
    ] as const) {
      expect(buildClientMessage(kind, CONTEXT)).toMatch(
        /^🤖 _Mensagem automática_\n\n/
      );
    }
  });

  it('chama o cliente pelo primeiro nome', () => {
    expect(buildClientMessage('low_balance', CONTEXT)).toContain('Oi, Ana!');
  });

  it('funciona sem nome de contato', () => {
    const text = buildClientMessage('low_balance', {
      ...CONTEXT,
      contactName: null,
    });
    expect(text).toContain('Oi! O saldo');
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
    expect(semCartao).toContain('não há forma de pagamento cadastrada');
    expect(semCartao).not.toContain('account_status');

    const cartao = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'unsettled',
    });
    expect(cartao).toContain('a cobrança no cartão não foi aprovada');
  });

  it('abre dizendo que os anúncios pararam, que é o que importa', () => {
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'unsettled',
    });
    expect(text).toContain('Oi, Ana! Seus anúncios pararam de rodar.');
    expect(text).toContain('me chame que libero o cartão');
  });

  it('conta que o saldo acabou quando foi isso que a leitura mostrou', () => {
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'unsettled',
      availableCents: 0,
    });
    expect(text).toContain('o saldo chegou ao fim');
    expect(text).toContain('a cobrança no cartão não foi aprovada');
  });

  it('não fala em saldo numa conta que não tem saldo a ler', () => {
    // Conta só de cartão: `availableCents` é null, e mandar o cliente
    // procurar um saldo que não existe esconde a ação certa.
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'unsettled',
      availableCents: null,
    });
    expect(text).not.toContain('saldo');
    expect(text).toContain('a cobrança no cartão não foi aprovada');
  });

  it('não diz que os anúncios pararam quando a conta só entrou em análise', () => {
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'risk_review',
    });
    expect(text).not.toContain('pararam de rodar');
    expect(text).toContain('a Meta abriu uma análise');
    // Liberar cartão não destrava análise de risco; prometer isso aqui
    // só geraria frustração.
    expect(text).not.toContain('libero o cartão');
  });

  it('não inventa explicação para um motivo desconhecido', () => {
    const text = buildClientMessage('payment_stopped', {
      ...CONTEXT,
      reasonCode: 'motivo_novo_da_meta',
    });
    expect(text).toContain('a cobrança foi interrompida');
    expect(text).not.toContain('motivo_novo_da_meta');
    expect(text).not.toContain('saldo');
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
