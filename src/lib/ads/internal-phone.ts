import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

/**
 * Valida o número interno que recebe a cópia dos alertas.
 *
 * Mora fora das rotas porque duas delas precisam do mesmo resultado, e
 * um arquivo de rota do Next só pode exportar handlers HTTP.
 *
 * Três respostas em vez de duas: vazio significa "sem cópia interna",
 * que é uma escolha legítima, e precisa ser distinguível de "a pessoa
 * digitou algo que não é telefone".
 */
export function parseInternalPhone(raw: unknown): string | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return 'invalid';
  if (raw.trim() === '') return null;

  const sanitized = sanitizePhoneForMeta(raw);
  return isValidE164(sanitized) ? sanitized : 'invalid';
}
