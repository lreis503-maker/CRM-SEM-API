import { describe, expect, it } from 'vitest';

import {
  AD_ACCOUNT_STATUS,
  RECOVERY_MARGIN,
  decideAlerts,
  evaluateAdAccountHealth,
  type MonitorAlertState,
} from './account-health';
import type { MetaAdAccountSnapshot } from './meta-ads-client';

function snapshot(
  overrides: Partial<MetaAdAccountSnapshot> = {}
): MetaAdAccountSnapshot {
  return {
    externalAccountId: '1234567890',
    name: 'Cliente A',
    currency: 'BRL',
    amountDueCents: 5000,
    amountSpentCents: 0,
    spendCapCents: null,
    isPrepayAccount: true,
    accountStatus: AD_ACCOUNT_STATUS.ACTIVE,
    disableReason: 0,
    hasFundingSource: true,
    availableFundsCents: 50000,
    fundingSourceDisplay: 'Saldo disponível (R$500,00 BRL)',
    fundingSourceType: 20,
    ...overrides,
  };
}

const QUIET: MonitorAlertState = {
  lowBalanceActive: false,
  lowBalanceAlertAt: null,
  paymentIssueActive: false,
  paymentIssueAlertAt: null,
  paymentIssueCode: null,
};

const NOW = new Date('2026-09-22T12:00:00.000Z');

describe('evaluateAdAccountHealth — saldo', () => {
  it('usa o saldo informado pela Meta quando existe', () => {
    const health = evaluateAdAccountHealth(
      snapshot({ availableFundsCents: 8000 })
    );
    expect(health.balanceBasis).toBe('available_funds');
    expect(health.availableCents).toBe(8000);
  });

  it('nunca confunde a fatura em aberto com o saldo', () => {
    // Esta é a regressão que importa: `balance` sobe conforme a conta
    // gasta. Tratá-lo como saldo invertia o alerta inteiro.
    const health = evaluateAdAccountHealth(
      snapshot({ amountDueCents: 9555, availableFundsCents: 27860 })
    );
    expect(health.availableCents).toBe(27860);
  });

  it('cai para o limite de gastos quando o saldo não pôde ser lido', () => {
    const health = evaluateAdAccountHealth(
      snapshot({
        availableFundsCents: null,
        spendCapCents: 100000,
        amountSpentCents: 93000,
      })
    );
    expect(health.balanceBasis).toBe('spend_cap');
    expect(health.availableCents).toBe(7000);
  });

  it('prefere o saldo informado ao limite de gastos', () => {
    const health = evaluateAdAccountHealth(
      snapshot({
        availableFundsCents: 27860,
        spendCapCents: 724081,
        amountSpentCents: 699606,
      })
    );
    // O limite daria R$ 244,75; a Meta informa R$ 278,60.
    expect(health.availableCents).toBe(27860);
  });

  it('nunca devolve saldo negativo quando o gasto passou do limite', () => {
    const health = evaluateAdAccountHealth(
      snapshot({
        availableFundsCents: null,
        spendCapCents: 100000,
        amountSpentCents: 150000,
      })
    );
    expect(health.availableCents).toBe(0);
  });

  it('não inventa saldo quando não há nem texto nem limite', () => {
    const health = evaluateAdAccountHealth(
      snapshot({
        availableFundsCents: null,
        spendCapCents: null,
        amountDueCents: 4500,
      })
    );
    expect(health.balanceBasis).toBe('none');
    expect(health.availableCents).toBeNull();
  });
});

describe('evaluateAdAccountHealth — cobrança', () => {
  it('conta ativa e paga não tem problema', () => {
    expect(evaluateAdAccountHealth(snapshot()).paymentIssue).toBeNull();
  });

  it('falta de forma de pagamento vem antes do status', () => {
    const health = evaluateAdAccountHealth(
      snapshot({
        hasFundingSource: false,
        accountStatus: AD_ACCOUNT_STATUS.DISABLED,
      })
    );
    expect(health.paymentIssue).toBe('no_funding_source');
  });

  it.each([
    [AD_ACCOUNT_STATUS.UNSETTLED, 'unsettled'],
    [AD_ACCOUNT_STATUS.IN_GRACE_PERIOD, 'in_grace_period'],
    [AD_ACCOUNT_STATUS.PENDING_SETTLEMENT, 'pending_settlement'],
    [AD_ACCOUNT_STATUS.PENDING_RISK_REVIEW, 'risk_review'],
    [AD_ACCOUNT_STATUS.DISABLED, 'disabled'],
    [AD_ACCOUNT_STATUS.PENDING_CLOSURE, 'pending_closure'],
    [AD_ACCOUNT_STATUS.CLOSED, 'closed'],
  ])('traduz account_status %i em %s', (status, expected) => {
    const health = evaluateAdAccountHealth(
      snapshot({ accountStatus: status as number })
    );
    expect(health.paymentIssue).toBe(expected);
  });

  it('não inventa significado para um status desconhecido', () => {
    expect(
      evaluateAdAccountHealth(snapshot({ accountStatus: 42 })).paymentIssue
    ).toBeNull();
  });

  it('não acusa falta de pagamento quando a Meta não informou o campo', () => {
    expect(
      evaluateAdAccountHealth(snapshot({ hasFundingSource: null })).paymentIssue
    ).toBeNull();
  });
});

describe('decideAlerts — saldo baixo', () => {
  const base = {
    thresholdCents: 10000,
    cooldownHours: 24,
    now: NOW,
  };

  it('avisa na primeira vez que o saldo cai abaixo do limite', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 9000,
        paymentIssue: null,
      },
      previous: QUIET,
    });

    expect(result.alerts).toEqual([
      { kind: 'low_balance', reasonCode: 'below_threshold' },
    ]);
    expect(result.next.lowBalanceActive).toBe(true);
    expect(result.next.lowBalanceAlertAt).toEqual(NOW);
  });

  it('não repete o aviso dentro do intervalo de espera', () => {
    const result = decideAlerts({
      ...base,
      health: { balanceBasis: 'available_funds', availableCents: 9000, paymentIssue: null },
      previous: {
        ...QUIET,
        lowBalanceActive: true,
        lowBalanceAlertAt: new Date(NOW.getTime() - 3 * 3_600_000),
      },
    });

    expect(result.alerts).toEqual([]);
  });

  it('repete o aviso quando o intervalo vence', () => {
    const result = decideAlerts({
      ...base,
      health: { balanceBasis: 'available_funds', availableCents: 9000, paymentIssue: null },
      previous: {
        ...QUIET,
        lowBalanceActive: true,
        lowBalanceAlertAt: new Date(NOW.getTime() - 25 * 3_600_000),
      },
    });

    expect(result.alerts).toEqual([
      { kind: 'low_balance', reasonCode: 'below_threshold' },
    ]);
  });

  it('com intervalo zero, avisa só na transição', () => {
    const result = decideAlerts({
      ...base,
      cooldownHours: 0,
      health: { balanceBasis: 'available_funds', availableCents: 9000, paymentIssue: null },
      previous: {
        ...QUIET,
        lowBalanceActive: true,
        lowBalanceAlertAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });

    expect(result.alerts).toEqual([]);
  });

  it('não desfaz o alerta enquanto o saldo não passa da margem', () => {
    const justAbove = 10000 * RECOVERY_MARGIN - 1;
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: justAbove,
        paymentIssue: null,
      },
      previous: { ...QUIET, lowBalanceActive: true, lowBalanceAlertAt: NOW },
    });

    expect(result.alerts).toEqual([]);
    expect(result.next.lowBalanceActive).toBe(true);
  });

  it('avisa a normalização quando o saldo passa da margem', () => {
    const result = decideAlerts({
      ...base,
      health: { balanceBasis: 'available_funds', availableCents: 12000, paymentIssue: null },
      previous: { ...QUIET, lowBalanceActive: true, lowBalanceAlertAt: NOW },
    });

    expect(result.alerts).toEqual([
      { kind: 'balance_recovered', reasonCode: 'above_threshold' },
    ]);
    expect(result.next.lowBalanceActive).toBe(false);
  });

  it('não manda normalização para quem nunca recebeu o alerta', () => {
    const result = decideAlerts({
      ...base,
      health: { balanceBasis: 'available_funds', availableCents: 90000, paymentIssue: null },
      previous: QUIET,
    });

    expect(result.alerts).toEqual([]);
  });

  it('preserva o estado quando a leitura não tem saldo para comparar', () => {
    const previous = {
      ...QUIET,
      lowBalanceActive: true,
      lowBalanceAlertAt: NOW,
    };
    const result = decideAlerts({
      ...base,
      health: { balanceBasis: 'none', availableCents: null, paymentIssue: null },
      previous,
    });

    expect(result.alerts).toEqual([]);
    expect(result.next.lowBalanceActive).toBe(true);
  });
});

describe('decideAlerts — cobrança', () => {
  const base = { thresholdCents: 10000, cooldownHours: 24, now: NOW };

  it('avisa quando a cobrança para', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 50000,
        paymentIssue: 'unsettled',
      },
      previous: QUIET,
    });

    expect(result.alerts).toEqual([
      { kind: 'payment_stopped', reasonCode: 'unsettled' },
    ]);
    expect(result.next.paymentIssueCode).toBe('unsettled');
  });

  it('avisa de novo quando o problema muda de natureza, mesmo no intervalo', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 50000,
        paymentIssue: 'disabled',
      },
      previous: {
        ...QUIET,
        paymentIssueActive: true,
        paymentIssueAlertAt: NOW,
        paymentIssueCode: 'unsettled',
      },
    });

    expect(result.alerts).toEqual([
      { kind: 'payment_stopped', reasonCode: 'disabled' },
    ]);
  });

  it('silencia o mesmo problema dentro do intervalo', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 50000,
        paymentIssue: 'unsettled',
      },
      previous: {
        ...QUIET,
        paymentIssueActive: true,
        paymentIssueAlertAt: new Date(NOW.getTime() - 60_000),
        paymentIssueCode: 'unsettled',
      },
    });

    expect(result.alerts).toEqual([]);
  });

  it('avisa a normalização quando o problema some', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 50000,
        paymentIssue: null,
      },
      previous: {
        ...QUIET,
        paymentIssueActive: true,
        paymentIssueAlertAt: NOW,
        paymentIssueCode: 'unsettled',
      },
    });

    expect(result.alerts).toEqual([
      { kind: 'payment_recovered', reasonCode: 'unsettled' },
    ]);
    expect(result.next.paymentIssueCode).toBeNull();
  });

  it('manda os dois avisos quando saldo e cobrança quebram juntos', () => {
    const result = decideAlerts({
      ...base,
      health: {
        balanceBasis: 'available_funds',
        availableCents: 100,
        paymentIssue: 'no_funding_source',
      },
      previous: QUIET,
    });

    expect(result.alerts.map((alert) => alert.kind)).toEqual([
      'low_balance',
      'payment_stopped',
    ]);
  });
});
