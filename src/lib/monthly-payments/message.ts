const MONTHS_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

export function buildMonthlyPaymentMessage(input: {
  recipientName: string;
  competence: string;
  amountCents: number;
  currency: string;
}): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(input.competence);
  const month = match ? MONTHS_PT[Number(match[2]) - 1] : undefined;
  if (!month) throw new Error('Competência inválida');

  const amount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: input.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(input.amountCents / 100)
    .replace(/\u00a0/g, ' ');

  return [
    '🤖 *Mensagem automática*',
    `Olá, ${input.recipientName.trim()}! A mensalidade referente a ${month} está no valor de ${amount}.`,
    'Quando for realizar o pagamento, me chame por aqui para eu enviar o Pix.',
  ].join('\n');
}

