/**
 * A única porta entre este CRM e a Marketing API da Meta.
 *
 * Só leitura. Nenhuma operação daqui cria, altera ou pausa qualquer
 * coisa numa conta de anúncio — o monitor avisa, não age.
 *
 * Decisões que valem para o arquivo inteiro:
 *
 * 1. O token vai em `Authorization: Bearer`, nunca em `?access_token=`.
 *    Query string aparece em log de proxy, em mensagem de erro e no
 *    histórico de requisição; header não.
 * 2. O corpo é lido com guardas em tempo de execução, não com `as`.
 *    A Meta devolve valores monetários como string, `spend_cap` some
 *    quando não há limite e `funding_source` some quando não há forma
 *    de pagamento — um cast transformaria qualquer uma dessas em um
 *    número errado dentro da regra de alerta.
 * 3. Valor monetário da Meta vem na menor unidade da moeda da conta
 *    (centavos, para BRL). Nada é dividido por 100 aqui: a conversão
 *    para reais acontece uma vez só, na hora de escrever a mensagem.
 */

import {
  MetaAdsClientError,
  classifyMetaAdsError,
  summarizeMetaAdsErrorBody,
} from './meta-ads-errors';

/**
 * Mesma versão usada pelo cliente do WhatsApp
 * (src/lib/whatsapp/meta-api.ts). Manter as duas juntas evita ter que
 * lembrar de dois calendários de descontinuação da Meta.
 */
const META_API_VERSION = 'v21.0';
const GRAPH_ORIGIN = 'https://graph.facebook.com';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Nenhuma resposta legítima deste cliente chega perto de 1 MiB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Campos pedidos na leitura de uma conta de anúncio. */
const AD_ACCOUNT_FIELDS = [
  'id',
  'account_id',
  'name',
  'currency',
  'account_status',
  'disable_reason',
  'balance',
  'amount_spent',
  'spend_cap',
  'is_prepay_account',
  'funding_source',
].join(',');

/**
 * O retrato de uma conta de anúncio, já normalizado.
 *
 * Todos os campos são anuláveis de propósito: `spend_cap`,
 * `is_prepay_account` e `funding_source` dependem de permissão e do
 * tipo de conta, e a regra de alerta precisa saber a diferença entre
 * "zero" e "a Meta não informou".
 */
export interface MetaAdAccountSnapshot {
  /** Só dígitos, sem o prefixo `act_`. */
  externalAccountId: string;
  name: string | null;
  /** ISO 4217, ex.: 'BRL'. */
  currency: string | null;
  /** Ver o cabeçalho: menor unidade da moeda. */
  balanceCents: number | null;
  amountSpentCents: number | null;
  /** `null` quando não há limite de gastos configurado. */
  spendCapCents: number | null;
  isPrepayAccount: boolean | null;
  accountStatus: number | null;
  disableReason: number | null;
  /** `false` quando a conta está sem forma de pagamento nenhuma. */
  hasFundingSource: boolean | null;
}

/** Uma conta como ela aparece na listagem, para a tela de cadastro. */
export interface MetaAdAccountSummary {
  externalAccountId: string;
  name: string | null;
  currency: string | null;
  accountStatus: number | null;
}

export interface MetaAdsClient {
  readAdAccount(externalAccountId: string): Promise<MetaAdAccountSnapshot>;
  /** Contas que este token enxerga. Primeira página, no máximo `limit`. */
  listAdAccounts(limit?: number): Promise<MetaAdAccountSummary[]>;
}

export interface CreateMetaAdsClientInput {
  accessToken: string;
  /** Injetável para teste. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiVersion?: string;
}

// --- normalização ---------------------------------------------------------

/**
 * Aceita `act_123`, `123` e `  act_123 `, devolve `123`.
 *
 * Existe porque a pessoa copia o id do Gerenciador de Anúncios de
 * formas diferentes e a UNIQUE do banco é sobre a forma canônica.
 */
export function normalizeAdAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const digits = trimmed.startsWith('act_') ? trimmed.slice(4) : trimmed;
  return /^[0-9]{1,32}$/.test(digits) ? digits : null;
}

/**
 * Converte um valor monetário da Meta para inteiro de centavos.
 *
 * A Meta manda string ("15000"), mas já mandou número em versões
 * antigas da API, então os dois são aceitos. Qualquer outra coisa
 * vira `null` em vez de `NaN` — um `NaN` silencioso aqui faria a
 * comparação de saldo baixo dar falso em toda leitura.
 */
export function parseMinorUnits(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^-?[0-9]+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  // A Graph API já devolveu 0/1 e "true"/"false" para campos booleanos.
  if (value === 0 || value === '0' || value === 'false') return false;
  if (value === 1 || value === '1' || value === 'true') return true;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `spend_cap` zero significa "sem limite" na Meta, não "não pode
 * gastar nada". Traduzir para `null` aqui impede que a regra de
 * alerta leia um teto de R$ 0,00 e acuse saldo baixo numa conta que
 * na verdade é ilimitada.
 */
function parseSpendCap(value: unknown): number | null {
  const parsed = parseMinorUnits(value);
  if (parsed === null || parsed === 0) return null;
  return parsed;
}

export function parseAdAccountSnapshot(
  body: unknown,
  fallbackId: string
): MetaAdAccountSnapshot {
  const record = asRecord(body);
  if (record === null) {
    throw new MetaAdsClientError({
      operation: 'adaccount.read',
      kind: 'invalid_response',
      details: { reason: 'response_not_an_object' },
    });
  }

  const externalAccountId =
    normalizeAdAccountId(record.account_id) ??
    normalizeAdAccountId(record.id) ??
    fallbackId;

  return {
    externalAccountId,
    name: asNonEmptyString(record.name),
    currency: asNonEmptyString(record.currency),
    balanceCents: parseMinorUnits(record.balance),
    amountSpentCents: parseMinorUnits(record.amount_spent),
    spendCapCents: parseSpendCap(record.spend_cap),
    isPrepayAccount: asBoolean(record.is_prepay_account),
    accountStatus: asInteger(record.account_status),
    disableReason: asInteger(record.disable_reason),
    // `funding_source` só vem quando existe uma forma de pagamento
    // ligada à conta. A ausência é o sinal, então ela é traduzida em
    // `false` — e não em `null` — quando o campo foi pedido.
    hasFundingSource:
      'funding_source' in record
        ? asNonEmptyString(record.funding_source) !== null
        : null,
  };
}

// --- transporte -----------------------------------------------------------

function utf8Length(text: string): number {
  if (text.length * 3 <= MAX_RESPONSE_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Lê no máximo `MAX_RESPONSE_BYTES`, em streaming quando o runtime
 * oferece o corpo como stream, para uma resposta gigante ser
 * abandonada em vez de carregada inteira na memória.
 */
async function readLimitedText(
  response: Response,
  operation: string
): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new MetaAdsClientError({
      operation,
      kind: 'invalid_response',
      httpStatus: response.status,
      details: { reason: 'response_too_large' },
    });
  }

  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    if (utf8Length(text) > MAX_RESPONSE_BYTES) {
      throw new MetaAdsClientError({
        operation,
        kind: 'invalid_response',
        httpStatus: response.status,
        details: { reason: 'response_too_large' },
      });
    }
    return text;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        throw new MetaAdsClientError({
          operation,
          kind: 'invalid_response',
          httpStatus: response.status,
          details: { reason: 'response_too_large' },
        });
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return text + decoder.decode();
}

function parseJsonBody(text: string, operation: string): unknown {
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MetaAdsClientError({
      operation,
      kind: 'invalid_response',
      details: { reason: 'response_not_json' },
    });
  }
}

function describeTransportFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name.length > 0) return cause.name;
  return 'unknown_transport_error';
}

export function createMetaAdsClient(
  input: CreateMetaAdsClientInput
): MetaAdsClient {
  const accessToken = asNonEmptyString(input.accessToken);
  if (accessToken === null) {
    throw new MetaAdsClientError({
      operation: 'client.create',
      kind: 'invalid_request',
      details: { reason: 'missing_access_token' },
    });
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const version = input.apiVersion ?? META_API_VERSION;
  const base = `${GRAPH_ORIGIN}/${version}`;

  async function request(
    operation: string,
    path: string,
    query: Record<string, string>
  ): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          // Ver o cabeçalho do arquivo: o token nunca vai na URL.
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new MetaAdsClientError({
        operation,
        kind: 'upstream_unavailable',
        details: { reason: describeTransportFailure(cause) },
        cause,
      });
    }

    const text = await readLimitedText(response, operation);
    const parsed = parseJsonBody(text, operation);

    if (!response.ok) {
      throw new MetaAdsClientError({
        operation,
        kind: classifyMetaAdsError(response.status, parsed),
        httpStatus: response.status,
        details: summarizeMetaAdsErrorBody(parsed),
      });
    }

    return parsed;
  }

  return {
    async readAdAccount(externalAccountId: string) {
      const id = normalizeAdAccountId(externalAccountId);
      if (id === null) {
        throw new MetaAdsClientError({
          operation: 'adaccount.read',
          kind: 'invalid_request',
          details: { reason: 'invalid_ad_account_id' },
        });
      }

      const body = await request('adaccount.read', `/act_${id}`, {
        fields: AD_ACCOUNT_FIELDS,
      });
      return parseAdAccountSnapshot(body, id);
    },

    async listAdAccounts(limit = 100) {
      const body = await request('adaccount.list', '/me/adaccounts', {
        fields: 'account_id,name,currency,account_status',
        limit: String(Math.min(Math.max(limit, 1), 200)),
      });

      const record = asRecord(body);
      const data = record?.data;
      if (!Array.isArray(data)) {
        throw new MetaAdsClientError({
          operation: 'adaccount.list',
          kind: 'invalid_response',
          details: { reason: 'missing_data_array' },
        });
      }

      const accounts: MetaAdAccountSummary[] = [];
      for (const entry of data) {
        const row = asRecord(entry);
        if (row === null) continue;
        const externalAccountId =
          normalizeAdAccountId(row.account_id) ?? normalizeAdAccountId(row.id);
        if (externalAccountId === null) continue;
        accounts.push({
          externalAccountId,
          name: asNonEmptyString(row.name),
          currency: asNonEmptyString(row.currency),
          accountStatus: asInteger(row.account_status),
        });
      }
      return accounts;
    },
  };
}
