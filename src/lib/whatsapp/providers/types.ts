export type WhatsAppProvider = 'meta' | 'uazapi';

export type WhatsAppConnectionStatus =
  | 'not_configured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated'
  | 'error';

export type WhatsAppCapability =
  | 'connection_status'
  | 'send_text'
  | 'send_media'
  | 'receive_text_media'
  | 'meta_service_window'
  | 'templates'
  | 'template_sync'
  | 'broadcasts'
  | 'interactive'
  | 'reactions'
  | 'location';

export interface WhatsAppCapabilitySnapshot {
  provider: WhatsAppProvider;
  status: WhatsAppConnectionStatus;
  connected: boolean;
  uazapiAvailable: boolean;
  capabilities: Record<WhatsAppCapability, boolean>;
}
