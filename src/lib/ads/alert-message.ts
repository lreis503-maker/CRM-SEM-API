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

/** O que o cliente precisa saber sobre cada tipo de parada. */
const PAYMENT_ISSUE_CLIENT: Record<PaymentIssueCode, string> = {
  no_funding_source:
    'a conta está sem forma de pagamento cadastrada, então os anúncios não vão entregar',
  unsettled:
    'há uma fatura em aberto que não foi paga — normalmente é o cartão que foi recusado',
  in_grace_period:
    'o pagamento falhou e a conta está no prazo extra da Meta antes de ser bloqueada',
  pending_settlement:
    'a Meta está tentando cobrar e ainda não conseguiu concluir o pagamento',
  risk_review: 'a conta entrou em análise da Meta e a entrega foi interrompida',
  disabled: 'a conta de anúncios foi desativada pela Meta',
  pending_closure: 'a conta de anúncios está em processo de encerramento',
  closed: 'a conta de anúncios foi encerrada',
};

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
      const motivo = isPaymentIssueCode(context.reasonCode)
        ? PAYMENT_ISSUE_CLIENT[context.reasonCode]
        : 'a cobrança da conta de anúncios foi interrompida';
      return (
        `${hello}Preciso te avisar de uma coisa importante: na conta de ` +
        `anúncios *${accountLabel}*, ${motivo}.\n\n` +
        'Enquanto isso não for resolvido, os anúncios ficam fora do ar. ' +
        'Dá para resolver atualizando a forma de pagamento no Gerenciador ' +
        'de Anúncios. Se preferir, me chama por aqui que eu te acompanho no passo a passo.'
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
