/**
 * A regra de alerta, isolada de banco e de rede de propósito.
 *
 * Tudo aqui é função pura: entra um retrato da conta de anúncio e o
 * estado da verificação anterior, sai a decisão de avisar ou não.
 * É o pedaço que mais precisa estar certo — um falso positivo manda
 * mensagem errada para o cliente do usuário — e é o que o teste
 * consegue cobrir inteiro sem tocar na Meta.
 */

import type { MetaAdAccountSnapshot } from './meta-ads-client';

/**
 * Valores de `account_status` da Marketing API.
 *
 * A Meta documenta o campo como inteiro sem listar os códigos na
 * página de referência; esta é a enumeração que a API usa na prática.
 * Código desconhecido não vira problema de cobrança: ele é gravado no
 * retrato e ignorado pela regra, porque inventar significado para um
 * código novo da Meta é como se manda mensagem errada para o cliente.
 */
export const AD_ACCOUNT_STATUS = {
  ACTIVE: 1,
  DISABLED: 2,
  UNSETTLED: 3,
  PENDING_RISK_REVIEW: 7,
  PENDING_SETTLEMENT: 8,
  IN_GRACE_PERIOD: 9,
  PENDING_CLOSURE: 100,
  CLOSED: 101,
} as const;

/**
 * Motivo estável do problema de cobrança. É o que fica gravado em
 * `ad_account_monitor_state.payment_issue_code`: mudar de código conta
 * como problema novo e dispara aviso mesmo dentro do intervalo de
 * espera, porque "fatura em aberto" e "conta desativada" pedem ações
 * diferentes do cliente.
 */
export type PaymentIssueCode =
  | 'no_funding_source'
  | 'unsettled'
  | 'in_grace_period'
  | 'pending_settlement'
  | 'risk_review'
  | 'disabled'
  | 'pending_closure'
  | 'closed';

/**
 * De onde saiu o saldo comparado com o limite.
 *
 * - `available_funds`: o saldo que a Meta informa no texto da forma de
 *   pagamento, idêntico ao que o Gerenciador de Anúncios mostra. É o
 *   melhor número disponível e tem prioridade sobre os outros.
 * - `spend_cap`: quanto ainda cabe antes de a Meta pausar as campanhas
 *   por limite de gastos. Serve de rede quando o texto não pôde ser
 *   lido, e erra para o lado seguro: costuma ficar abaixo do saldo
 *   real, então avisa cedo demais em vez de tarde demais.
 * - `none`: não há saldo a comparar. A regra de saldo baixo não roda —
 *   só a de cobrança. Fingir um número aqui geraria alerta em toda
 *   leitura.
 *
 * O campo `balance` da Meta não aparece em lugar nenhum desta lista, e
 * é de propósito: ele é a fatura em aberto e **cresce** conforme a
 * conta gasta. Usá-lo como saldo inverte a regra — foi o bug que esta
 * versão corrige.
 */
export type BalanceBasis = 'available_funds' | 'spend_cap' | 'none';

export interface AdAccountHealth {
  balanceBasis: BalanceBasis;
  /** `null` quando `balanceBasis` é `none`. */
  availableCents: number | null;
  paymentIssue: PaymentIssueCode | null;
}

/**
 * Margem para o alerta de saldo baixo se desfazer.
 *
 * Sem ela, uma conta parada exatamente no limite alternaria entre
 * "abaixo" e "acima" a cada gasto de centavos, e o cliente receberia
 * "seu saldo acabou" e "seu saldo voltou" alternadamente. O alerta
 * dispara em `saldo < limite` e só se desfaz em `saldo >= limite * 1,2`.
 */
export const RECOVERY_MARGIN = 1.2;

/**
 * Lê o retrato e diz em que pé a conta está.
 *
 * A ordem dos testes de cobrança é do mais específico para o mais
 * genérico: uma conta desativada por falta de pagamento deve ser
 * descrita como falta de pagamento, não como "desativada".
 */
export function evaluateAdAccountHealth(
  snapshot: MetaAdAccountSnapshot
): AdAccountHealth {
  return {
    ...resolveAvailableBalance(snapshot),
    paymentIssue: resolvePaymentIssue(snapshot),
  };
}

function resolveAvailableBalance(
  snapshot: MetaAdAccountSnapshot
): { balanceBasis: BalanceBasis; availableCents: number | null } {
  if (snapshot.availableFundsCents !== null) {
    return {
      balanceBasis: 'available_funds',
      availableCents: snapshot.availableFundsCents,
    };
  }

  if (snapshot.spendCapCents !== null && snapshot.amountSpentCents !== null) {
    // A Meta pausa as campanhas quando o gasto acumulado alcança o
    // teto, então o que sobra do teto é o saldo efetivo da conta.
    // Nunca negativo: gasto acima do teto é zero de saldo, não dívida.
    const remaining = snapshot.spendCapCents - snapshot.amountSpentCents;
    return {
      balanceBasis: 'spend_cap',
      availableCents: Math.max(remaining, 0),
    };
  }

  return { balanceBasis: 'none', availableCents: null };
}

function resolvePaymentIssue(
  snapshot: MetaAdAccountSnapshot
): PaymentIssueCode | null {
  // Sem forma de pagamento os anúncios simplesmente não entregam, e a
  // Meta documenta isso sem mudar o `account_status`. É o sinal mais
  // direto de "o cartão parou" e por isso vem primeiro.
  if (snapshot.hasFundingSource === false) return 'no_funding_source';

  switch (snapshot.accountStatus) {
    case AD_ACCOUNT_STATUS.UNSETTLED:
      return 'unsettled';
    case AD_ACCOUNT_STATUS.IN_GRACE_PERIOD:
      return 'in_grace_period';
    case AD_ACCOUNT_STATUS.PENDING_SETTLEMENT:
      return 'pending_settlement';
    case AD_ACCOUNT_STATUS.PENDING_RISK_REVIEW:
      return 'risk_review';
    case AD_ACCOUNT_STATUS.DISABLED:
      return 'disabled';
    case AD_ACCOUNT_STATUS.PENDING_CLOSURE:
      return 'pending_closure';
    case AD_ACCOUNT_STATUS.CLOSED:
      return 'closed';
    default:
      return null;
  }
}

// --- decisão de avisar ----------------------------------------------------

/** O que a verificação anterior tinha deixado gravado. */
export interface MonitorAlertState {
  lowBalanceActive: boolean;
  lowBalanceAlertAt: Date | null;
  paymentIssueActive: boolean;
  paymentIssueAlertAt: Date | null;
  paymentIssueCode: string | null;
}

export type AlertKind =
  | 'low_balance'
  | 'payment_stopped'
  | 'balance_recovered'
  | 'payment_recovered';

export interface AlertDecision {
  kind: AlertKind;
  reasonCode: string;
}

export interface DecideAlertsInput {
  health: AdAccountHealth;
  previous: MonitorAlertState;
  thresholdCents: number;
  cooldownHours: number;
  now: Date;
}

export interface DecideAlertsResult {
  alerts: AlertDecision[];
  /** O estado a gravar depois desta verificação. */
  next: MonitorAlertState;
}

function cooldownElapsed(
  lastAlertAt: Date | null,
  cooldownHours: number,
  now: Date
): boolean {
  // Intervalo zero significa "avise só na transição": enquanto o
  // problema continuar do mesmo jeito, nada mais é enviado.
  if (cooldownHours <= 0) return false;
  if (lastAlertAt === null) return true;
  return now.getTime() - lastAlertAt.getTime() >= cooldownHours * 3_600_000;
}

/**
 * Decide o que enviar e o que gravar.
 *
 * Três motivos para um aviso sair:
 *  1. o problema acabou de começar;
 *  2. o problema mudou de natureza (código diferente);
 *  3. o problema continua e o intervalo de espera venceu.
 *
 * E um para o aviso de normalização: o problema deixou de existir,
 * mas só se o CRM chegou a avisar sobre ele — ninguém deve receber
 * "seu saldo voltou ao normal" sem nunca ter recebido o alerta.
 */
export function decideAlerts(input: DecideAlertsInput): DecideAlertsResult {
  const { health, previous, thresholdCents, cooldownHours, now } = input;
  const alerts: AlertDecision[] = [];

  // --- saldo ---------------------------------------------------------
  let lowBalanceActive = previous.lowBalanceActive;
  let lowBalanceAlertAt = previous.lowBalanceAlertAt;

  if (health.availableCents === null) {
    // Sem base de comparação nesta leitura: o estado anterior é
    // preservado em vez de ser zerado. Uma conta que perdeu o teto de
    // gastos não deve mandar "saldo normalizado" por causa disso.
  } else if (health.availableCents < thresholdCents) {
    if (
      !lowBalanceActive ||
      cooldownElapsed(lowBalanceAlertAt, cooldownHours, now)
    ) {
      alerts.push({ kind: 'low_balance', reasonCode: 'below_threshold' });
      lowBalanceAlertAt = now;
    }
    lowBalanceActive = true;
  } else if (
    lowBalanceActive &&
    health.availableCents >= thresholdCents * RECOVERY_MARGIN
  ) {
    alerts.push({ kind: 'balance_recovered', reasonCode: 'above_threshold' });
    lowBalanceActive = false;
    lowBalanceAlertAt = null;
  }

  // --- cobrança ------------------------------------------------------
  let paymentIssueActive = previous.paymentIssueActive;
  let paymentIssueAlertAt = previous.paymentIssueAlertAt;
  let paymentIssueCode = previous.paymentIssueCode;

  if (health.paymentIssue !== null) {
    const changed = paymentIssueCode !== health.paymentIssue;
    if (
      !paymentIssueActive ||
      changed ||
      cooldownElapsed(paymentIssueAlertAt, cooldownHours, now)
    ) {
      alerts.push({
        kind: 'payment_stopped',
        reasonCode: health.paymentIssue,
      });
      paymentIssueAlertAt = now;
    }
    paymentIssueActive = true;
    paymentIssueCode = health.paymentIssue;
  } else if (paymentIssueActive) {
    alerts.push({
      kind: 'payment_recovered',
      reasonCode: paymentIssueCode ?? 'resolved',
    });
    paymentIssueActive = false;
    paymentIssueAlertAt = null;
    paymentIssueCode = null;
  }

  return {
    alerts,
    next: {
      lowBalanceActive,
      lowBalanceAlertAt,
      paymentIssueActive,
      paymentIssueAlertAt,
      paymentIssueCode,
    },
  };
}
