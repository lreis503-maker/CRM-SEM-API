import { describe, expect, it, vi } from 'vitest';

import {
  createMetaAdsClient,
  normalizeAdAccountId,
  parseAdAccountSnapshot,
  parseDisplayAmountCents,
  parseMinorUnits,
} from './meta-ads-client';
import { MetaAdsClientError } from './meta-ads-errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('normalizeAdAccountId', () => {
  it.each([
    ['act_123456', '123456'],
    ['  act_123456  ', '123456'],
    ['123456', '123456'],
  ])('aceita %s', (input, expected) => {
    expect(normalizeAdAccountId(input)).toBe(expected);
  });

  it.each(['', 'act_', 'abc', 'act_12a', null, undefined, 123])(
    'recusa %s',
    (input) => {
      expect(normalizeAdAccountId(input)).toBeNull();
    }
  );
});

describe('parseMinorUnits', () => {
  it('lê a string que a Meta manda', () => {
    expect(parseMinorUnits('15000')).toBe(15000);
    expect(parseMinorUnits('-2500')).toBe(-2500);
  });

  it('aceita número, que a API antiga devolvia', () => {
    expect(parseMinorUnits(15000)).toBe(15000);
  });

  it('devolve null em vez de NaN para valor ilegível', () => {
    // Um NaN aqui faria toda comparação de saldo dar falso em silêncio.
    expect(parseMinorUnits('15.000,00')).toBeNull();
    expect(parseMinorUnits('R$ 150')).toBeNull();
    expect(parseMinorUnits(1.5)).toBeNull();
    expect(parseMinorUnits(null)).toBeNull();
  });
});

describe('parseDisplayAmountCents', () => {
  it('lê o texto que a Meta devolve numa conta pré-paga brasileira', () => {
    expect(
      parseDisplayAmountCents('Saldo disponível (R$278,60 BRL)', 'BRL')
    ).toBe(27860);
  });

  it.each([
    ['R$1.278,60', 'BRL', 127860],
    ['$1,278.60', 'USD', 127860],
    ['R$ 1.278', 'BRL', 127800],
    ['R$0,00', 'BRL', 0],
    ['Available funds (278.60 USD)', 'USD', 27860],
  ])('lê %s', (display, currency, expected) => {
    expect(parseDisplayAmountCents(display, currency)).toBe(expected);
  });

  it('não lê número de cartão como se fosse saldo', () => {
    // Sem esta guarda, o alerta sairia dizendo que o cliente tem
    // R$ 1.234 de saldo porque o cartão termina em 1234.
    expect(parseDisplayAmountCents('Visa ···· 1234', 'BRL')).toBeNull();
    expect(parseDisplayAmountCents('Mastercard **** 4321', 'BRL')).toBeNull();
    expect(parseDisplayAmountCents('Boleto bancário', 'BRL')).toBeNull();
  });

  it('devolve null para texto vazio ou ausente', () => {
    expect(parseDisplayAmountCents(null, 'BRL')).toBeNull();
    expect(parseDisplayAmountCents('   ', 'BRL')).toBeNull();
  });
});

describe('parseAdAccountSnapshot', () => {
  // Resposta real da conta Casa Uniart, capturada no Explorador da API.
  const CASA_UNIART = {
    name: 'Casa Uniart',
    currency: 'BRL',
    account_status: 1,
    balance: '9555',
    amount_spent: '699606',
    spend_cap: '724081',
    is_prepay_account: true,
    funding_source: '8658821880896410',
    funding_source_details: {
      id: '8658821880896410',
      display_string: 'Saldo disponível (R$278,60 BRL)',
      type: 20,
    },
    id: 'act_1667636610825801',
  };

  it('lê o saldo real de uma conta pré-paga', () => {
    const parsed = parseAdAccountSnapshot(CASA_UNIART, '1667636610825801');

    expect(parsed.availableFundsCents).toBe(27860);
    expect(parsed.fundingSourceType).toBe(20);
    expect(parsed.externalAccountId).toBe('1667636610825801');
  });

  it('não confunde a fatura em aberto com o saldo', () => {
    const parsed = parseAdAccountSnapshot(CASA_UNIART, '1');

    // `balance` é o quanto a conta deve, e sobe conforme ela gasta.
    expect(parsed.amountDueCents).toBe(9555);
    expect(parsed.amountDueCents).not.toBe(parsed.availableFundsCents);
  });

  it('lê o corpo completo', () => {
    const parsed = parseAdAccountSnapshot(
      {
        id: 'act_123',
        account_id: '123',
        name: 'Cliente A',
        currency: 'BRL',
        account_status: 1,
        disable_reason: 0,
        balance: '8750',
        amount_spent: '430000',
        spend_cap: '500000',
        is_prepay_account: true,
        funding_source: '99887766',
        funding_source_details: {
          display_string: 'Saldo disponível (R$120,00 BRL)',
          type: 20,
        },
      },
      '123'
    );

    expect(parsed).toEqual({
      externalAccountId: '123',
      name: 'Cliente A',
      currency: 'BRL',
      amountDueCents: 8750,
      amountSpentCents: 430000,
      spendCapCents: 500000,
      isPrepayAccount: true,
      accountStatus: 1,
      disableReason: 0,
      hasFundingSource: true,
      availableFundsCents: 12000,
      fundingSourceDisplay: 'Saldo disponível (R$120,00 BRL)',
      fundingSourceType: 20,
    });
  });

  it('não extrai saldo de conta que não é pré-paga', () => {
    // Em conta no cartão o texto descreve o cartão, não um saldo.
    const parsed = parseAdAccountSnapshot(
      {
        account_id: '123',
        currency: 'BRL',
        is_prepay_account: false,
        funding_source_details: { display_string: 'Visa ···· 4321', type: 1 },
      },
      '123'
    );

    expect(parsed.availableFundsCents).toBeNull();
    expect(parsed.fundingSourceDisplay).toBe('Visa ···· 4321');
  });

  it('trata spend_cap zero como "sem limite", não como teto de zero', () => {
    const parsed = parseAdAccountSnapshot({ spend_cap: '0' }, '123');
    expect(parsed.spendCapCents).toBeNull();
  });

  it('marca a ausência de forma de pagamento quando o campo veio vazio', () => {
    expect(
      parseAdAccountSnapshot({ funding_source: '' }, '123').hasFundingSource
    ).toBe(false);
  });

  it('distingue "não informado" de "não tem"', () => {
    expect(parseAdAccountSnapshot({}, '123').hasFundingSource).toBeNull();
  });

  it('cai para o id passado quando o corpo não traz nenhum', () => {
    expect(parseAdAccountSnapshot({ name: 'X' }, '777').externalAccountId).toBe(
      '777'
    );
  });

  it('recusa um corpo que não é objeto', () => {
    expect(() => parseAdAccountSnapshot('não é json', '1')).toThrow(
      MetaAdsClientError
    );
  });
});

describe('createMetaAdsClient', () => {
  it('manda o token no header e nunca na URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ account_id: '123', name: 'Cliente A' })
    );

    await createMetaAdsClient({
      accessToken: 'TOKEN-SECRETO',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).readAdAccount('act_123');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).not.toContain('TOKEN-SECRETO');
    expect(url).toContain('/act_123');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer TOKEN-SECRETO'
    );
  });

  it('recusa um cliente sem token', () => {
    expect(() => createMetaAdsClient({ accessToken: '  ' })).toThrow(
      MetaAdsClientError
    );
  });

  it('recusa um id de conta inválido antes de chamar a rede', async () => {
    const fetchImpl = vi.fn();
    const client = createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readAdAccount('conta-do-joão')).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifica token expirado como unauthorized', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: 'Error validating access token',
            type: 'OAuthException',
            code: 190,
            fbtrace_id: 'ABC',
          },
        },
        400
      )
    );

    const client = createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readAdAccount('123')).rejects.toMatchObject({
      kind: 'unauthorized',
      httpStatus: 400,
    });
  });

  it('classifica limite de chamadas como repetível', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 17, message: 'User request limit reached' } }, 400)
    );

    const client = createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readAdAccount('123')).rejects.toMatchObject({
      kind: 'rate_limited',
    });

    const error = await client.readAdAccount('123').catch((e) => e);
    expect((error as MetaAdsClientError).retryable).toBe(true);
  });

  it('não repete a leitura quando a rede cai', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const client = createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readAdAccount('123')).rejects.toMatchObject({
      kind: 'upstream_unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('não deixa o corpo de erro da Meta arrastar campos desconhecidos', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 190,
            message: 'expirou',
            segredo_interno: 'não deveria vazar',
          },
        },
        400
      )
    );

    const client = createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = (await client
      .readAdAccount('123')
      .catch((e) => e)) as MetaAdsClientError;

    expect(error.details).toEqual({ code: 190, message: 'expirou' });
  });

  it('lista as contas que o token enxerga, ignorando linhas sem id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { account_id: '111', name: 'A', currency: 'BRL', account_status: 1 },
          { name: 'sem id' },
          { account_id: '222', name: 'B', currency: 'BRL', account_status: 2 },
        ],
      })
    );

    const accounts = await createMetaAdsClient({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).listAdAccounts();

    expect(accounts.map((account) => account.externalAccountId)).toEqual([
      '111',
      '222',
    ]);
  });
});
