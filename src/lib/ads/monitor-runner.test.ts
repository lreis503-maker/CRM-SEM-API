import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { encrypt } from '@/lib/whatsapp/encryption';

import { runAdAccountMonitors, summarizeDelivery } from './monitor-runner';
import type { MetaAdAccountSnapshot, MetaAdsClient } from './meta-ads-client';
import { MetaAdsClientError } from './meta-ads-errors';

// --- banco de mentira ------------------------------------------------------
//
// Reproduz só o que o runner usa do PostgREST: filtros encadeados,
// `maybeSingle`/`single`, e os quatro verbos de escrita. Cada escrita é
// registrada para o teste poder afirmar sobre ela.

interface Write {
  table: string;
  op: 'insert' | 'update' | 'upsert' | 'delete';
  payload: unknown;
}

function fakeDb(fixtures: Record<string, Record<string, unknown>[]>) {
  const writes: Write[] = [];
  let insertedId = 0;

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let pending: Record<string, unknown> | null = null;

    function rows(): Record<string, unknown>[] {
      // Uma escrita responde com a linha que acabou de nascer; uma
      // leitura responde com o fixture filtrado.
      if (pending !== null) return [pending];
      return (fixtures[table] ?? []).filter(
        (row) =>
          filters.every(([column, value]) => row[column] === value) &&
          inFilters.every(([column, values]) => values.includes(row[column]))
      );
    }

    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push([column, values]);
        return query;
      },
      order: () => query,
      limit: () => query,
      insert: (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'insert', payload });
        insertedId += 1;
        pending = { id: `row-${insertedId}`, ...payload };
        return query;
      },
      upsert: (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'upsert', payload });
        pending = { id: `row-${(insertedId += 1)}`, ...payload };
        return query;
      },
      update: (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'update', payload });
        pending = { id: 'updated', ...payload };
        return query;
      },
      delete: () => {
        writes.push({ table, op: 'delete', payload: null });
        pending = {};
        return query;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
        resolve({ data: rows(), error: null }),
    };

    return query;
  }

  const db = { from: (table: string) => builder(table) };
  return { db: db as unknown as SupabaseClient, writes };
}

// --- fixtures --------------------------------------------------------------

const NOW = new Date('2026-09-22T12:00:00.000Z');

function baseFixtures(
  overrides: Partial<Record<string, Record<string, unknown>[]>> = {}
) {
  return {
    ad_account_monitors: [
      {
        id: 'mon-1',
        account_id: 'acc-1',
        credential_id: 'cred-1',
        platform: 'meta',
        enabled: true,
        external_account_id: '1234567890',
        display_name: 'Cliente A',
        contact_id: 'contact-1',
        low_balance_threshold_cents: 10000,
        currency: 'BRL',
        notify_client: true,
        notify_internal: true,
        cooldown_hours: 24,
      },
    ],
    ad_account_monitor_state: [],
    ad_platform_credentials: [
      {
        id: 'cred-1',
        account_id: 'acc-1',
        platform: 'meta',
        label: 'BM da agência',
        business_id: null,
        internal_notify_phone: '+5511988887777',
        last_verified_at: null,
        last_verify_error: null,
      },
    ],
    ad_platform_credential_secrets: [
      { credential_id: 'cred-1', access_token: encrypt('TOKEN-DO-BM') },
    ],
    contacts: [{ id: 'contact-1', account_id: 'acc-1', name: 'Ana Paula' }],
    ad_account_alerts: [],
    ...overrides,
  } as Record<string, Record<string, unknown>[]>;
}

function snapshot(
  overrides: Partial<MetaAdAccountSnapshot> = {}
): MetaAdAccountSnapshot {
  return {
    externalAccountId: '1234567890',
    name: 'Cliente A',
    currency: 'BRL',
    amountDueCents: 5000,
    availableFundsCents: 50000,
    fundingSourceDisplay: 'Saldo disponível (R$500,00 BRL)',
    fundingSourceType: 20,
    amountSpentCents: 0,
    spendCapCents: null,
    isPrepayAccount: true,
    accountStatus: 1,
    disableReason: 0,
    hasFundingSource: true,
    ...overrides,
  };
}

// O parâmetro é declarado mesmo sem ser usado porque é ele que os
// testes inspecionam: qual token foi entregue a qual leitura.
function clientReturning(
  value: MetaAdAccountSnapshot | Error
): (accessToken: string) => MetaAdsClient {
  return (_accessToken: string) =>
    ({
      readAdAccount: async () => {
        if (value instanceof Error) throw value;
        return value;
      },
      listAdAccounts: async () => [],
    }) as MetaAdsClient;
}

// --- testes ----------------------------------------------------------------

describe('runAdAccountMonitors', () => {
  it('não avisa ninguém quando a conta está saudável', async () => {
    const { db, writes } = fakeDb(baseFixtures());
    const sendToContact = vi.fn();
    const sendToPhone = vi.fn();

    const result = await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(snapshot()),
        sendToContact,
        sendToPhone,
      }
    );

    expect(result).toMatchObject({ checked: 1, alerts: 0, failures: 0 });
    expect(sendToContact).not.toHaveBeenCalled();
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(
      writes.some((write) => write.table === 'ad_account_alerts')
    ).toBe(false);
  });

  it('avisa cliente e equipe quando o saldo cai abaixo do limite', async () => {
    const { db, writes } = fakeDb(baseFixtures());
    const sendToContact = vi.fn();
    const sendToPhone = vi.fn();

    const result = await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(snapshot({ availableFundsCents: 8750 })),
        sendToContact,
        sendToPhone,
      }
    );

    expect(result.alerts).toBe(1);
    expect(sendToContact).toHaveBeenCalledOnce();
    expect(sendToPhone).toHaveBeenCalledOnce();

    // O cliente recebe o limite; o saldo exato e o id da conta ficam
    // na cópia interna.
    const clientText = sendToContact.mock.calls[0][0].text;
    expect(clientText).toMatch(/100,00/);
    expect(clientText).not.toMatch(/87,50/);
    expect(clientText).not.toContain('act_');

    const internalText = sendToPhone.mock.calls[0][0].text;
    expect(internalText).toContain('act_1234567890');
    expect(internalText).toMatch(/87,50/);

    const state = writes.find(
      (write) => write.table === 'ad_account_monitor_state'
    );
    expect(state?.payload).toMatchObject({
      low_balance_active: true,
      available_cents: 8750,
      // A fatura em aberto é gravada como veio, separada do saldo.
      balance_cents: 5000,
      funding_source_display: 'Saldo disponível (R$500,00 BRL)',
      currency: 'BRL',
      consecutive_failures: 0,
    });
  });

  it('marca a entrega como parcial quando só uma das pontas falha', async () => {
    const { db, writes } = fakeDb(baseFixtures());

    await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(snapshot({ hasFundingSource: false })),
        sendToContact: vi.fn().mockRejectedValue(new Error('sem telefone')),
        sendToPhone: vi.fn(),
      }
    );

    const update = writes.find(
      (write) =>
        write.table === 'ad_account_alerts' && write.op === 'update'
    );
    expect(update?.payload).toMatchObject({
      delivery_status: 'partial',
      client_error: 'sem telefone',
      internal_error: null,
    });
  });

  it('grava o alerta antes de enviar, para um envio que falhou não sumir', async () => {
    const { db, writes } = fakeDb(baseFixtures());

    await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(snapshot({ accountStatus: 3 })),
        sendToContact: vi.fn().mockRejectedValue(new Error('falhou')),
        sendToPhone: vi.fn().mockRejectedValue(new Error('falhou também')),
      }
    );

    const insert = writes.find(
      (write) =>
        write.table === 'ad_account_alerts' && write.op === 'insert'
    );
    expect(insert?.payload).toMatchObject({
      kind: 'payment_stopped',
      reason_code: 'unsettled',
    });

    const update = writes.find(
      (write) =>
        write.table === 'ad_account_alerts' && write.op === 'update'
    );
    expect(update?.payload).toMatchObject({ delivery_status: 'failed' });
  });

  it('respeita o intervalo mínimo entre leituras', async () => {
    const fixtures = baseFixtures({
      ad_account_monitor_state: [
        {
          monitor_id: 'mon-1',
          account_id: 'acc-1',
          checked_at: new Date(NOW.getTime() - 60_000).toISOString(),
          consecutive_failures: 0,
          low_balance_active: false,
          payment_issue_active: false,
        },
      ],
    });
    const { db } = fakeDb(fixtures);
    const createClient = vi.fn(clientReturning(snapshot()));

    const result = await runAdAccountMonitors(
      db,
      { minIntervalMinutes: 10 },
      { now: NOW, createClient, sendToContact: vi.fn(), sendToPhone: vi.fn() }
    );

    expect(result).toMatchObject({ checked: 0, skipped: 1 });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('não manda mensagem para o cliente quando a leitura falha', async () => {
    const { db } = fakeDb(baseFixtures());
    const sendToContact = vi.fn();
    const sendToPhone = vi.fn();

    const result = await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(
          new MetaAdsClientError({
            operation: 'adaccount.read',
            kind: 'unauthorized',
          })
        ),
        sendToContact,
        sendToPhone,
      }
    );

    expect(result.failures).toBe(1);
    expect(sendToContact).not.toHaveBeenCalled();
    // Token morto precisa de ação humana: a equipe é avisada na hora.
    expect(sendToPhone).toHaveBeenCalledOnce();
    expect(sendToPhone.mock.calls[0][0].text).toContain('token');
  });

  it('segura o aviso de falha repetível até a terceira tentativa', async () => {
    const transient = new MetaAdsClientError({
      operation: 'adaccount.read',
      kind: 'upstream_unavailable',
    });
    const sendToPhone = vi.fn();

    // O aviso sai uma vez só, exatamente quando o contador chega a 3.
    // Começando já em 3, a próxima falha leva a 4 e nada é enviado:
    // a equipe já foi avisada e continuar mandando seria ruído.
    for (const [failures, expected] of [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 0],
    ] as const) {
      sendToPhone.mockClear();
      const { db } = fakeDb(
        baseFixtures({
          ad_account_monitor_state: [
            {
              monitor_id: 'mon-1',
              account_id: 'acc-1',
              checked_at: null,
              consecutive_failures: failures,
              low_balance_active: false,
              payment_issue_active: false,
            },
          ],
        })
      );

      await runAdAccountMonitors(
        db,
        {},
        {
          now: NOW,
          createClient: clientReturning(transient),
          sendToContact: vi.fn(),
          sendToPhone,
        }
      );

      expect(sendToPhone).toHaveBeenCalledTimes(expected);
    }
  });

  it('não lê nada quando o portfólio ainda não tem token', async () => {
    const { db } = fakeDb(
      baseFixtures({
        ad_platform_credential_secrets: [],
      })
    );
    const createClient = vi.fn();
    const sendToPhone = vi.fn();

    const result = await runAdAccountMonitors(
      db,
      {},
      { now: NOW, createClient, sendToContact: vi.fn(), sendToPhone }
    );

    expect(result.failures).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    // Nada é enviado: quem precisa configurar já está dentro do CRM.
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  it('pula a conta que ainda não tem portfólio escolhido', async () => {
    const fixtures = baseFixtures();
    fixtures.ad_account_monitors[0].credential_id = null;
    const { db, writes } = fakeDb(fixtures);
    const createClient = vi.fn();

    const result = await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient,
        sendToContact: vi.fn(),
        sendToPhone: vi.fn(),
      }
    );

    expect(result.failures).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    const state = writes.find(
      (write) => write.table === 'ad_account_monitor_state'
    );
    expect(state?.payload).toMatchObject({
      last_error: expect.stringContaining('portfólio'),
    });
  });

  it('decifra o token uma vez só por portfólio', async () => {
    const fixtures = baseFixtures();
    fixtures.ad_account_monitors.push({
      ...fixtures.ad_account_monitors[0],
      id: 'mon-2',
      external_account_id: '999',
    });
    const { db } = fakeDb(fixtures);
    const createClient = vi.fn(clientReturning(snapshot()));

    await runAdAccountMonitors(
      db,
      {},
      { now: NOW, createClient, sendToContact: vi.fn(), sendToPhone: vi.fn() }
    );

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith('TOKEN-DO-BM');
  });

  it('usa o token do portfólio de cada conta', async () => {
    const fixtures = baseFixtures();
    fixtures.ad_platform_credentials.push({
      id: 'cred-2',
      account_id: 'acc-1',
      platform: 'meta',
      label: 'Segundo portfólio',
      business_id: null,
      internal_notify_phone: '+5511900001111',
      last_verified_at: null,
      last_verify_error: null,
    });
    fixtures.ad_platform_credential_secrets.push({
      credential_id: 'cred-2',
      access_token: encrypt('TOKEN-DO-OUTRO-BM'),
    });
    fixtures.ad_account_monitors.push({
      ...fixtures.ad_account_monitors[0],
      id: 'mon-2',
      credential_id: 'cred-2',
      external_account_id: '999',
      contact_id: null,
    });

    const { db } = fakeDb(fixtures);
    const createClient = vi.fn(clientReturning(snapshot({ availableFundsCents: 10 })));
    const sendToPhone = vi.fn();

    await runAdAccountMonitors(
      db,
      {},
      { now: NOW, createClient, sendToContact: vi.fn(), sendToPhone }
    );

    expect(createClient.mock.calls.map((call) => call[0])).toEqual([
      'TOKEN-DO-BM',
      'TOKEN-DO-OUTRO-BM',
    ]);

    // Cada portfólio avisa o seu próprio número interno.
    expect(sendToPhone.mock.calls.map((call) => call[0].phone)).toEqual([
      '+5511988887777',
      '+5511900001111',
    ]);
  });

  it('não avisa o cliente quando o monitor só tem cópia interna', async () => {
    const fixtures = baseFixtures();
    fixtures.ad_account_monitors[0].notify_client = false;
    const { db } = fakeDb(fixtures);
    const sendToContact = vi.fn();
    const sendToPhone = vi.fn();

    await runAdAccountMonitors(
      db,
      {},
      {
        now: NOW,
        createClient: clientReturning(snapshot({ availableFundsCents: 100 })),
        sendToContact,
        sendToPhone,
      }
    );

    expect(sendToContact).not.toHaveBeenCalled();
    expect(sendToPhone).toHaveBeenCalledOnce();
  });
});

describe('summarizeDelivery', () => {
  it.each([
    [true, true, null, null, 'sent'],
    [true, true, 'erro', null, 'partial'],
    [true, true, 'erro', 'erro', 'failed'],
    [true, false, null, null, 'sent'],
    [false, false, null, null, 'skipped'],
  ] as const)(
    'cliente=%s interna=%s → %s',
    (clientAttempted, internalAttempted, clientError, internalError, expected) => {
      expect(
        summarizeDelivery({
          clientAttempted,
          internalAttempted,
          clientError,
          internalError,
        })
      ).toBe(expected);
    }
  );
});
