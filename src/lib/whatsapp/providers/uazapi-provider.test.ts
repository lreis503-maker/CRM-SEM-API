import { describe, expect, it, vi } from 'vitest';

import { createUazapiProvider } from './uazapi-provider';

function provider() {
  const sendText = vi.fn().mockResolvedValue({
    messageId: '3EB0538DA65A59F6D8A251',
    chatId: null,
    status: 'Sent',
    timestamp: null,
  });
  const sendMedia = vi.fn().mockResolvedValue({
    messageId: 'uaz-media-1',
    chatId: null,
    status: 'Sent',
    timestamp: null,
  });

  const client = {
    sendText,
    sendMedia,
    configureWebhook: vi.fn(),
    connect: vi.fn(),
    getStatus: vi.fn(),
    disconnect: vi.fn(),
    deleteInstance: vi.fn(),
    downloadMessage: vi.fn(),
    findChats: vi.fn(),
    findMessages: vi.fn(),
  };

  return { transport: createUazapiProvider(client), sendText, sendMedia };
}

describe('createUazapiProvider', () => {
  it('sends text with the CRM tracking fields', async () => {
    const { transport, sendText } = provider();

    const result = await transport.send('5511999999999', {
      kind: 'text',
      text: 'Ola',
      replyToExternalId: '3EB0000000000000000000',
      trackId: 'local-uuid-1',
    });

    expect(sendText).toHaveBeenCalledWith({
      number: '5511999999999',
      text: 'Ola',
      replyId: '3EB0000000000000000000',
      trackSource: 'wacrm',
      trackId: 'local-uuid-1',
    });
    expect(result).toEqual({
      provider: 'uazapi',
      externalMessageId: '3EB0538DA65A59F6D8A251',
      status: 'sent',
    });
  });

  it('addresses a LID exactly as stored', async () => {
    const { transport, sendText } = provider();

    await transport.send('182736@lid', {
      kind: 'text',
      text: 'Ola',
      trackId: 'local-1',
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ number: '182736@lid' })
    );
  });

  it('maps audio to a voice message', async () => {
    const { transport, sendMedia } = provider();

    await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'audio',
      url: 'https://cdn.example.com/a.ogg',
      trackId: 'local-2',
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ptt',
        file: 'https://cdn.example.com/a.ogg',
      })
    );
  });

  it('sends a document with its name and caption', async () => {
    const { transport, sendMedia } = provider();

    await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'document',
      url: 'https://cdn.example.com/a.pdf',
      caption: 'Segue o documento',
      filename: 'Contrato.pdf',
      trackId: 'local-3',
    });

    expect(sendMedia).toHaveBeenCalledWith({
      number: '5511999999999',
      type: 'document',
      file: 'https://cdn.example.com/a.pdf',
      caption: 'Segue o documento',
      docName: 'Contrato.pdf',
      replyId: undefined,
      trackSource: 'wacrm',
      trackId: 'local-3',
    });
  });

  it('keeps image and video kinds as they are', async () => {
    const { transport, sendMedia } = provider();

    await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'image',
      url: 'https://cdn.example.com/a.jpg',
      trackId: 'local-4',
    });
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image' })
    );

    await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'video',
      url: 'https://cdn.example.com/a.mp4',
      trackId: 'local-5',
    });
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'video' })
    );
  });

  it('never sends a document name on a non-document', async () => {
    const { transport, sendMedia } = provider();

    await transport.send('5511999999999', {
      kind: 'media',
      mediaKind: 'image',
      url: 'https://cdn.example.com/a.jpg',
      filename: 'ignored.jpg',
      trackId: 'local-6',
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ docName: undefined })
    );
  });

  it('makes a single attempt and propagates the failure', async () => {
    const { transport, sendText } = provider();
    sendText.mockRejectedValue(new Error('timeout'));

    await expect(
      transport.send('5511999999999', {
        kind: 'text',
        text: 'Ola',
        trackId: 'local-7',
      })
    ).rejects.toThrow('timeout');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('reports its provider so the message row records it', () => {
    expect(provider().transport.provider).toBe('uazapi');
  });
});
