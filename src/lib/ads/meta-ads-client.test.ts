import { describe, expect, it, vi } from 'vitest';

import {
  createMetaAdsClient,
  normalizeAdAccountId,
  parseAdAccountSnapshot,
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

describe('parseAdAccountSnapshot', () => {
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
      },
      '123'
    );

    expect(parsed).toEqual({
      externalAccountId: '123',
      name: 'Cliente A',
      currency: 'BRL',
      balanceCents: 8750,
      amountSpentCents: 430000,
      spendCapCents: 500000,
      isPrepayAccount: true,
      accountStatus: 1,
      disableReason: 0,
      hasFundingSource: true,
    });
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
