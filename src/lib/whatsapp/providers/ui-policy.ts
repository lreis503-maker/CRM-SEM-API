import type { WhatsAppCapability, WhatsAppCapabilitySnapshot } from './types';

export type ProviderUiPolicyMessage = 'metaOnly' | 'unavailable';

const defaultCopy: Record<ProviderUiPolicyMessage, string> = {
  metaOnly: 'Disponivel somente com a API oficial da Meta',
  unavailable: 'Recurso indisponivel enquanto a conexao do WhatsApp carrega',
};

export function providerDisabledReason(
  snapshot: WhatsAppCapabilitySnapshot | null,
  capability: WhatsAppCapability,
  t: (key: ProviderUiPolicyMessage) => string = (key) => defaultCopy[key]
): string | null {
  if (snapshot?.capabilities[capability] === true) return null;

  return snapshot?.provider === 'uazapi' ? t('metaOnly') : t('unavailable');
}
