/**
 * O texto que sai no WhatsApp.
 *
 * Fica separado da regra porque são coisas que mudam por motivos
 * diferentes: a regra muda quando a Meta muda; o texto muda quando o
 * usuário quer falar de outro jeito com os clientes dele.
 *
 * Duas versões de cada aviso:
 *  - a do cliente, sem jargão e com o que ele precisa fazer;
 *  - a cópia interna, com id da conta e números, para a equipe agir
 *    antes de o cliente responder.
 *
 * Está em português direto no código, e não em `messages/`, porque
 * este texto é conteúdo de negócio que vai para o WhatsApp de outra
 * pessoa — não é rótulo de tela, e o idioma dele não acompanha o
 * idioma que o atendente escolheu no CRM.
 */

import type { AlertKind, PaymentIssueCode } from './account-health';

export interface AlertMessageContext {
  /** Nome da conta de anúncio como a Meta devolve, ou o id. */
  accountLabel: string;
  /** Só dígitos. Aparece apenas na cópia interna. */
  externalAccountId: string;
  /** Primeiro nome do contato, quando conhecido. */
  contactName?: string | null;
  currency: string;
  availableCents: number | null;
  thresholdCents: number;
  reasonCode: string;
}

/**
 * Formata centavos como moeda com as duas casas.
 *
 * `formatCurrency` de `src/lib/currency.ts` arredonda para inteiro
 * porque serve aos cartões do painel. Num aviso de saldo, "R$ 87"
 * quando o saldo é R$ 87,40 é impreciso do jeito errado.
 */
export function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const code = (currency || 'BRL').trim();
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Código ISO inválido vindo do banco não pode derrubar um envio.
    return `${code} ${new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)}`;
  }
}

/**
 * O que aconteceu, na voz do cliente.
 *
 * Os três primeiros são falha de cobrança no cartão. `unsettled` tem
 * duas versões porque a causa muda a ação: numa conta que tem saldo e
 * cartão juntos, o saldo acabou e a Meta tentou o cartão; numa conta
 * só de cartão não existe saldo, e falar em saldo mandaria a pessoa
 * procurar algo que não existe.
 */
const PAYMENT_ISSUE_CLIENT: Record<PaymentIssueCode, string> = {
  no_funding_source: 'não há forma de pagamento cadastrada',
  unsettled: 'a cobrança no cartão não foi aprovada',
  in_grace_period:
    'a cobrança no cartão falhou e a conta está no prazo extra da Meta antes de ser bloqueada',
  pending_settlement:
    'a Meta está tentando cobrar o cartão e ainda não conseguiu concluir',
  // Redigidos para encaixar depois de "Na conta de anúncios *X*, ".
  risk_review: 'a Meta abriu uma análise',
  disabled: 'a Meta desativou a veiculação',
  pending_closure: 'há um encerramento em andamento',
  closed: 'o encerramento foi concluído',
};

/**
 * A versão de quando o saldo lido era zero: aí a sequência inteira é
 * conhecida e vale contar, porque explica por que parou justo agora.
 */
const PAYMENT_ISSUE_CLIENT_OUT_OF_FUNDS: Partial<
  Record<PaymentIssueCode, string>
> = {
  unsettled:
    'o saldo chegou ao fim e a cobrança no cartão não foi aprovada',
  in_grace_period:
    'o saldo chegou ao fim, a cobrança no cartão falhou e a conta está no prazo extra da Meta',
  pending_settlement:
    'o saldo chegou ao fim e a Meta ainda não conseguiu concluir a cobrança no cartão',
};

/** Códigos em que a entrega para na hora. Os demais variam. */
const STOPS_DELIVERY: ReadonlySet<PaymentIssueCode> = new Set([
  'no_funding_source',
  'unsettled',
  'in_grace_period',
  'pending_settlement',
  'disabled',
  'closed',
]);

/**
 * Códigos em que quem resolve é a agência, liberando o cartão.
 *
 * O cliente não mexe em nada: a chamada para ação é chamar no WhatsApp.
 * Os demais códigos (análise de risco, encerramento) não se resolvem
 * assim, e prometer isso neles só geraria frustração.
 */
const FIXABLE_BY_PAYMENT: ReadonlySet<PaymentIssueCode> = new Set([
  'no_funding_source',
  'unsettled',
  'in_grace_period',
  'pending_settlement',
]);

/**
 * Aviso no topo de toda mensagem que vai para o cliente.
 *
 * Existe porque quem recebe não tem como saber que do outro lado é um
 * robô: a mensagem chega no mesmo número em que a pessoa conversa com
 * a equipe. Sem o aviso, um "ok, obrigada" ficaria sem resposta e
 * pareceria descaso.
 */
const AUTOMATIC_NOTICE = '🤖 _Mensagem automática_';

/** O que a equipe faz a respeito. */
const PAYMENT_ISSUE_INTERNAL: Record<PaymentIssueCode, string> = {
  no_funding_source: 'sem forma de pagamento (funding_source ausente)',
  unsettled: 'fatura em aberto (account_status 3 UNSETTLED)',
  in_grace_period: 'pagamento falhou, em carência (account_status 9)',
  pending_settlement: 'cobrança pendente (account_status 8)',
  risk_review: 'em análise de risco (account_status 7)',
  disabled: 'conta desativada (account_status 2)',
  pending_closure: 'encerramento em andamento (account_status 100)',
  closed: 'conta encerrada (account_status 101)',
};

function isPaymentIssueCode(value: string): value is PaymentIssueCode {
  return value in PAYMENT_ISSUE_CLIENT;
}

function greeting(contactName?: string | null): string {
  const first = (contactName ?? '').trim().split(/\s+/)[0];
  return first ? `Oi, ${first}! ` : 'Oi! ';
}

/**
 * A mensagem do cliente.
 *
 * Sem o id da conta de propósito: para o cliente ele não significa
 * nada e só dá a impressão de mensagem automática de sistema.
 */
export function buildClientMessage(
  kind: AlertKind,
  context: AlertMessageContext
): string {
  return `${AUTOMATIC_NOTICE}\n\n${clientBody(kind, context)}`;
}

function clientBody(kind: AlertKind, context: AlertMessageContext): string {
  const { accountLabel, currency, thresholdCents } = context;
  const hello = greeting(context.contactName);

  switch (kind) {
    case 'low_balance':
      // Só o limite, nunca o saldo exato. Quem recebe precisa saber que
      // chegou a hora de repor; o número de agora já estará velho quando
      // a pessoa abrir o Gerenciador, e expor o caixa da conta numa
      // mensagem que pode ser encaminhada não traz nada em troca.
      return (
        `${hello}O saldo da conta de anúncios *${accountLabel}* está ` +
        `abaixo de ${formatMoney(thresholdCents, currency)}.`
      );

    case 'payment_stopped': {
      const code = isPaymentIssueCode(context.reasonCode)
        ? context.reasonCode
        : null;

      if (code === null) {
        return (
          `${hello}Seus anúncios pararam de rodar.\n` +
          `Na conta de anúncios *${accountLabel}*, a cobrança foi interrompida.\n` +
          'Me chama por aqui que eu te explico o que dá para fazer.'
        );
      }

      // Saldo zerado que conhecemos conta a história inteira; nos
      // demais casos a frase genérica é a honesta.
      const outOfFunds =
        context.availableCents === 0
          ? PAYMENT_ISSUE_CLIENT_OUT_OF_FUNDS[code]
          : undefined;
      const motivo = outOfFunds ?? PAYMENT_ISSUE_CLIENT[code];

      // A abertura já diz que parou, então o motivo não repete a
      // consequência — foi o que produziu frases com dois "então".
      const abertura = STOPS_DELIVERY.has(code)
        ? 'Seus anúncios pararam de rodar.'
        : 'Preciso te avisar de uma coisa importante.';

      const acao = FIXABLE_BY_PAYMENT.has(code)
        ? 'Para voltar a rodar ainda hoje, me chame que libero o cartão.'
        : 'Me chama por aqui que eu te explico o que dá para fazer.';

      return (
        `${hello}${abertura}\n` +
        `Na conta de anúncios *${accountLabel}*, ${motivo}.\n` +
        acao
      );
    }

    case 'balance_recovered':
      // Mesma regra do aviso de saldo baixo: sem o número.
      return (
        `${hello}Tudo certo: o saldo da conta de anúncios *${accountLabel}* ` +
        'foi reposto e os anúncios seguem rodando normalmente.'
      );

    case 'payment_recovered':
      return (
        `${hello}Boa notícia: a cobrança da conta de anúncios ` +
        `*${accountLabel}* voltou ao normal e os anúncios já estão ` +
        'entregando de novo.'
      );
  }
}

/**
 * A cópia interna.
 *
 * Carrega id e números porque quem lê vai abrir o Gerenciador de
 * Anúncios em seguida.
 */
export function buildInternalMessage(
  kind: AlertKind,
  context: AlertMessageContext
): string {
  const {
    accountLabel,
    externalAccountId,
    currency,
    availableCents,
    thresholdCents,
  } = context;

  const conta = `${accountLabel} (act_${externalAccountId})`;
  const cliente = context.contactName?.trim()
    ? `\nCliente: ${context.contactName.trim()}`
    : '\nCliente: sem contato vinculado (só cópia interna)';

  switch (kind) {
    case 'low_balance':
      return (
        `⚠️ Saldo baixo\nConta: ${conta}${cliente}\n` +
        `Saldo: ${availableCents === null ? 'indisponível' : formatMoney(availableCents, currency)}\n` +
        `Limite: ${formatMoney(thresholdCents, currency)}`
      );

    case 'payment_stopped': {
      const motivo = isPaymentIssueCode(context.reasonCode)
        ? PAYMENT_ISSUE_INTERNAL[context.reasonCode]
        : `motivo não mapeado (${context.reasonCode})`;
      return (
        `🚨 Cobrança parada\nConta: ${conta}${cliente}\n` +
        `Motivo: ${motivo}`
      );
    }

    case 'balance_recovered':
      return (
        `✅ Saldo normalizado\nConta: ${conta}${cliente}\n` +
        `Saldo: ${availableCents === null ? 'indisponível' : formatMoney(availableCents, currency)}`
      );

    case 'payment_recovered':
      return `✅ Cobrança normalizada\nConta: ${conta}${cliente}`;
  }
}
