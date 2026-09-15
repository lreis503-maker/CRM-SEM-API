import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CAPABILITIES,
  ProviderNotSupportedError,
  assertProviderCapability,
  supportsCapability,
} from './capabilities';

describe('WhatsApp provider capabilities', () => {
  it('keeps Meta templates and broadcasts enabled', () => {
    expect(supportsCapability('meta', 'templates')).toBe(true);
    expect(supportsCapability('meta', 'broadcasts')).toBe(true);
  });

  it('allows only the UAZAPI v1 core', () => {
    expect(supportsCapability('uazapi', 'connection_status')).toBe(true);
    expect(supportsCapability('uazapi', 'send_text')).toBe(true);
    expect(supportsCapability('uazapi', 'send_media')).toBe(true);
    expect(supportsCapability('uazapi', 'receive_text_media')).toBe(true);
    expect(supportsCapability('uazapi', 'meta_service_window')).toBe(false);
    expect(supportsCapability('uazapi', 'templates')).toBe(false);
    expect(supportsCapability('uazapi', 'template_sync')).toBe(false);
    expect(supportsCapability('uazapi', 'broadcasts')).toBe(false);
    expect(supportsCapability('uazapi', 'interactive')).toBe(false);
    expect(supportsCapability('uazapi', 'reactions')).toBe(false);
    expect(supportsCapability('uazapi', 'location')).toBe(false);
  });

  it('keeps the capability matrix immutable at runtime', () => {
    expect(Object.isFrozen(PROVIDER_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CAPABILITIES.meta)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CAPABILITIES.uazapi)).toBe(true);
  });

  it('throws a stable error for an unsupported operation', () => {
    expect(() => assertProviderCapability('uazapi', 'broadcasts')).toThrow(
      ProviderNotSupportedError
    );

    try {
      assertProviderCapability('uazapi', 'broadcasts');
    } catch (error) {
      expect(error).toMatchObject({
        provider: 'uazapi',
        capability: 'broadcasts',
        code: 'provider_not_supported',
        status: 409,
      });
    }
  });

  it('accepts a supported operation', () => {
    expect(() => assertProviderCapability('meta', 'templates')).not.toThrow();
  });
});
