/**
 * Erros tipados do cliente da Marketing API.
 *
 * Duas regras que valem para todo erro daqui:
 *
 * 1. Nenhum campo carrega o token. O token vai no header
 *    `Authorization`, nunca na URL, justamente para não vazar em
 *    mensagem de erro, log de proxy ou histórico de requisição.
 * 2. `retryable` diz se a mesma leitura pode ser repetida. Toda
 *    operação deste cliente é de leitura, então repetir é seguro; o
 *    campo existe para o runner distinguir "a Meta está fora do ar"
 *    de "o token não serve mais", que exigem reações diferentes.
 */

export type MetaAdsErrorKind =
  /** A chamada foi montada errada aqui dentro (id inválido, token vazio). */
  | 'invalid_request'
  /** Token expirado, revogado ou sem o escopo `ads_read`. */
  | 'unauthorized'
  /** Token válido, mas sem acesso a esta conta de anúncio. */
  | 'forbidden'
  /** A conta de anúncio não existe ou foi apagada. */
  | 'not_found'
  /** Limite de chamadas da Meta. */
  | 'rate_limited'
  /** A Meta respondeu com erro de servidor. */
  | 'upstream_error'
  /** Não houve resposta: timeout, DNS, conexão derrubada. */
  | 'upstream_unavailable'
  /** Houve resposta, mas o corpo não bate com o contrato. */
  | 'invalid_response';

export interface MetaAdsClientErrorInput {
  operation: string;
  kind: MetaAdsErrorKind;
  httpStatus?: number | null;
  /** Corpo de erro da Meta já reduzido ao essencial. Sem credenciais. */
  details?: unknown;
  cause?: unknown;
}

export class MetaAdsClientError extends Error {
  readonly operation: string;
  readonly kind: MetaAdsErrorKind;
  readonly httpStatus: number | null;
  readonly details: unknown;

  constructor(input: MetaAdsClientErrorInput) {
    super(`${input.operation}: ${input.kind}`);
    this.name = 'MetaAdsClientError';
    this.operation = input.operation;
    this.kind = input.kind;
    this.httpStatus = input.httpStatus ?? null;
    this.details = input.details;
    if (input.cause !== undefined) this.cause = input.cause;
  }

  /**
   * Um erro repetível é de infraestrutura: tentar de novo no próximo
   * ciclo pode dar certo sem ninguém mexer em nada. Os demais precisam
   * de ação humana (trocar o token, reconectar a conta) e por isso
   * viram aviso interno em vez de silêncio.
   */
  get retryable(): boolean {
    return (
      this.kind === 'upstream_unavailable' ||
      this.kind === 'upstream_error' ||
      this.kind === 'rate_limited'
    );
  }

  /** Texto curto em português para a tela e para o aviso interno. */
  get humanMessage(): string {
    switch (this.kind) {
      case 'invalid_request':
        return 'A consulta foi montada com dados inválidos.';
      case 'unauthorized':
        return 'O token do Business Manager expirou ou perdeu a permissão de leitura de anúncios.';
      case 'forbidden':
        return 'O token não tem acesso a esta conta de anúncio.';
      case 'not_found':
        return 'Esta conta de anúncio não existe mais ou não está visível para o token.';
      case 'rate_limited':
        return 'A Meta recusou a consulta por limite de chamadas. A próxima verificação tenta de novo.';
      case 'upstream_error':
        return 'A Meta respondeu com erro. A próxima verificação tenta de novo.';
      case 'upstream_unavailable':
        return 'Não foi possível falar com a Meta. A próxima verificação tenta de novo.';
      case 'invalid_response':
        return 'A Meta respondeu num formato inesperado.';
    }
  }
}

/**
 * Classificação por status HTTP. A Meta devolve 400 para praticamente
 * tudo que é erro de aplicação, então o corpo é quem decide entre
 * "token morreu" e "pedido inválido" — ver `classifyMetaAdsError`.
 */
export function classifyMetaAdsHttpStatus(status: number): MetaAdsErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'upstream_error';
}

/** Códigos de erro da Graph API que significam credencial inutilizável. */
const AUTH_ERROR_CODES = new Set([102, 190, 458, 459, 460, 463, 464, 467]);

/** Códigos que significam limite de chamadas atingido. */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613, 80000, 80004]);

/** Códigos de permissão: o token é válido, o acesso é que não existe. */
const PERMISSION_ERROR_CODES = new Set([10, 200, 272, 294]);

/**
 * Lê `error.code` / `error.type` do corpo da Graph API e devolve a
 * classificação mais específica que o corpo permitir, caindo para a
 * classificação por status quando o corpo não ajuda.
 */
export function classifyMetaAdsError(
  status: number,
  body: unknown
): MetaAdsErrorKind {
  const error =
    typeof body === 'object' && body !== null
      ? (body as { error?: unknown }).error
      : null;

  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; type?: unknown };
    const code = typeof record.code === 'number' ? record.code : null;

    if (code !== null) {
      if (AUTH_ERROR_CODES.has(code)) return 'unauthorized';
      if (RATE_LIMIT_ERROR_CODES.has(code)) return 'rate_limited';
      if (PERMISSION_ERROR_CODES.has(code)) return 'forbidden';
      // 803: "Some of the aliases you requested do not exist" — é o que
      // a Meta devolve para uma conta de anúncio inexistente.
      if (code === 803 || code === 100) return 'not_found';
    }

    if (record.type === 'OAuthException' && status === 400) {
      return 'unauthorized';
    }
  }

  return classifyMetaAdsHttpStatus(status);
}

/**
 * Reduz o corpo de erro da Meta ao que é útil num log: código,
 * subcódigo, tipo e mensagem. Campos como `fbtrace_id` passam porque
 * são exatamente o que o suporte da Meta pede. Nada mais é copiado,
 * para um corpo inesperado não arrastar dado de cliente para o log.
 */
export function summarizeMetaAdsErrorBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return {};

  const record = error as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'code',
    'error_subcode',
    'type',
    'message',
    'error_user_title',
    'error_user_msg',
    'fbtrace_id',
  ]) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      summary[key] = value;
    }
  }
  return summary;
}
