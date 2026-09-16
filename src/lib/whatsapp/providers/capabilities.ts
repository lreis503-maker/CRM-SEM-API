import type { WhatsAppCapability, WhatsAppProvider } from './types';

type ProviderCapabilityMatrix = Readonly<
  Record<WhatsAppProvider, Readonly<Record<WhatsAppCapability, boolean>>>
>;

export const PROVIDER_CAPABILITIES: ProviderCapabilityMatrix = Object.freeze({
  meta: Object.freeze({
    connection_status: true,
    send_text: true,
    send_media: true,
    receive_text_media: true,
    meta_service_window: true,
    templates: true,
    template_sync: true,
    broadcasts: true,
    interactive: true,
    reactions: true,
    location: true,
  }),
  uazapi: Object.freeze({
    connection_status: true,
    send_text: true,
    send_media: true,
    receive_text_media: true,
    meta_service_window: false,
    templates: false,
    template_sync: false,
    broadcasts: false,
    interactive: false,
    reactions: false,
    location: false,
  }),
});

export class ProviderNotSupportedError extends Error {
  readonly code = 'provider_not_supported';
  readonly status = 409;

  constructor(
    readonly provider: WhatsAppProvider,
    readonly capability: WhatsAppCapability
  ) {
    super(`Provider ${provider} does not support ${capability}`);
    this.name = 'ProviderNotSupportedError';
  }
}

export function supportsCapability(
  provider: WhatsAppProvider,
  capability: WhatsAppCapability
): boolean {
  return PROVIDER_CAPABILITIES[provider][capability];
}

export function assertProviderCapability(
  provider: WhatsAppProvider,
  capability: WhatsAppCapability
): void {
  if (!supportsCapability(provider, capability)) {
    throw new ProviderNotSupportedError(provider, capability);
  }
}
