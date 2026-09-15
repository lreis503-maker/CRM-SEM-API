import { describe, expect, it, vi } from 'vitest';

import { createMetaProvider } from './meta-provider';

function provider(overrides: Record<string, unknown> = {}) {
  const sendText = vi.fn().mockResolvedValue({ messageId: 'wamid.text' });
  const sendMedia = vi.fn().mockResolvedValue({ messageId: 'wamid.media' });

  const transport = createMetaProvider({
    phoneNumberId: 'phone-1',
    accessToken: 'meta-token',
    fns: { sendText, sendMedia, ...overrides },
  });

  return { transport, sendText, sendMedia };
}

describe('createMetaProvider', () => {
  it('sends text through the existing Meta payload, unchanged', async () => {
    const { transport, sendText } = provider();

    const result = await transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      replyToExternalId: 'wamid.parent',
      trackId: 'local-1',
    });

    expect(sendText).toHaveBeenCalledWith({
      phoneNumberId: 'phone-1',
      accessToken: 'meta-token',
      to: '5511999999999',
      text: 'Ola',
      contextMessageId: 'wamid.parent',
    });
    expect(result).toEqual({
      provider: 'meta',
      externalMessageId: 'wamid.text',
      status: 'sent',
    });
  });

  it('omits the reply context when there is nothing to quote', async () => {
    const { transport, sendText } = provider();

    await transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      trackId: 'local-1',
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessageId: undefined })
    );
  });

  it('sends media with the same kind, caption and filename as before', async () => {
    const { transport, sendMedia } = provider();

    const result = await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'document',
      url: 'https://cdn.example.com/a.pdf',
      caption: 'Segue',
      filename: 'Contrato.pdf',
      trackId: 'local-2',
    });

    expect(sendMedia).toHaveBeenCalledWith({
      phoneNumberId: 'phone-1',
      accessToken: 'meta-token',
      to: '5511999999999',
      kind: 'document',
      link: 'https://cdn.example.com/a.pdf',
      caption: 'Segue',
      filename: 'Contrato.pdf',
      contextMessageId: undefined,
    });
    expect(result.externalMessageId).toBe('wamid.media');
  });

  it('never sends the CRM tracking id to Meta', async () => {
    const { transport, sendText } = provider();

    await transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      trackId: 'local-uuid-1',
    });

    expect(JSON.stringify(sendText.mock.calls)).not.toContain('local-uuid-1');
  });

  it('reports its provider so the message row records it', () => {
    expect(provider().transport.provider).toBe('meta');
  });
});
