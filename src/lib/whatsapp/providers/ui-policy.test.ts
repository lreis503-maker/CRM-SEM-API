import { describe, expect, it } from 'vitest';

import type { WhatsAppCapabilitySnapshot } from './types';
import { providerDisabledReason } from './ui-policy';

const uazapiSnapshot: WhatsAppCapabilitySnapshot = {
  provider: 'uazapi',
  status: 'connected',
  connected: true,
  uazapiAvailable: true,
  capabilities: {
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
  },
};

describe('providerDisabledReason', () => {
  it('explains why a Meta-only action is disabled under UAZAPI', () => {
    expect(providerDisabledReason(uazapiSnapshot, 'templates')).toBe(
      'Disponível somente com a API oficial da Meta'
    );
  });

  it('does not disable a supported UAZAPI action', () => {
    expect(providerDisabledReason(uazapiSnapshot, 'send_text')).toBeNull();
  });
});
