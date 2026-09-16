import { describe, expect, it } from 'vitest';

import {
  isMetaReaction,
  normalizeMetaMessage,
  normalizeMetaStatus,
  type MetaInboundMessage,
} from './meta-normalizer';

const CONTACT = { profile: { name: 'Ada' }, wa_id: '15551230000' };
const TS = '1789000000';
const TS_ISO = new Date(1789000000 * 1000).toISOString();

function message(overrides: Partial<MetaInboundMessage>): MetaInboundMessage {
  return {
    id: 'wamid.1',
    from: '15551230000',
    timestamp: TS,
    type: 'text',
    ...overrides,
  };
}

describe('normalizeMetaMessage — identity', () => {
  it('reads a phone sender', () => {
    const event = normalizeMetaMessage(
      message({ text: { body: 'oi' } }),
      CONTACT
    );

    expect(event).toMatchObject({
      kind: 'message',
      provider: 'meta',
      externalMessageId: 'wamid.1',
      occurredAt: TS_ISO,
      fromMe: false,
      isGroup: false,
      replyToExternalId: null,
    });
    expect(event?.sender).toMatchObject({
      phone: '15551230000',
      externalId: null,
      externalIdKind: null,
      profileName: 'Ada',
    });
  });

  it('reads a username-only sender by business-scoped id', () => {
    const event = normalizeMetaMessage(
      message({
        from: undefined,
        from_user_id: 'US.13491208655302741918',
        text: { body: 'oi' },
      }),
      {
        profile: { name: 'Ada', username: 'ada' },
        user_id: 'US.13491208655302741918',
      }
    );

    expect(event?.sender).toMatchObject({
      phone: '',
      externalId: 'US.13491208655302741918',
      externalIdKind: 'bsuid',
      username: 'ada',
    });
  });

  it('refuses a message with neither a phone nor a business-scoped id', () => {
    expect(
      normalizeMetaMessage(message({ from: undefined, text: { body: 'oi' } }), {
        profile: {},
      })
    ).toBeNull();
  });

  it('keeps the supplied profile name apart from the display fallback', () => {
    const event = normalizeMetaMessage(message({ text: { body: 'oi' } }), {
      profile: {},
      wa_id: '15551230000',
    });

    // Nothing was supplied, so a backfill must not overwrite an agent's
    // hand-edited name with the phone number.
    expect(event?.sender.profileName).toBeNull();
    expect(event?.sender.displayName).toBe('15551230000');
  });
});

describe('normalizeMetaMessage — content', () => {
  it('normalizes text', () => {
    expect(
      normalizeMetaMessage(message({ text: { body: 'oi' } }), CONTACT)?.content
    ).toEqual({ type: 'text', text: 'oi' });
  });

  it('normalizes each media kind with its caption and locator', () => {
    const image = normalizeMetaMessage(
      message({
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'veja' },
      }),
      CONTACT
    );
    expect(image?.content).toEqual({
      type: 'image',
      text: 'veja',
      media: {
        externalMediaId: 'media-1',
        locator: 'provider_id',
        locatorValue: 'media-1',
        mimeType: 'image/jpeg',
        fileName: null,
        fileSize: null,
      },
    });

    const doc = normalizeMetaMessage(
      message({
        type: 'document',
        document: {
          id: 'media-2',
          mime_type: 'application/pdf',
          filename: 'nota.pdf',
        },
      }),
      CONTACT
    );
    expect(doc?.content).toMatchObject({
      type: 'document',
      text: 'nota.pdf',
      media: { fileName: 'nota.pdf' },
    });

    const audio = normalizeMetaMessage(
      message({
        type: 'audio',
        audio: { id: 'media-3', mime_type: 'audio/ogg' },
      }),
      CONTACT
    );
    expect(audio?.content).toMatchObject({ type: 'audio', text: null });

    const video = normalizeMetaMessage(
      message({
        type: 'video',
        video: { id: 'media-4', mime_type: 'video/mp4' },
      }),
      CONTACT
    );
    expect(video?.content).toMatchObject({ type: 'video' });
  });

  it('treats a sticker as an image, which is what the schema allows', () => {
    expect(
      normalizeMetaMessage(
        message({
          type: 'sticker',
          sticker: { id: 'media-5', mime_type: 'image/webp' },
        }),
        CONTACT
      )?.content
    ).toMatchObject({ type: 'image' });
  });

  it('keeps media null when the payload announced it but sent no id', () => {
    expect(
      normalizeMetaMessage(message({ type: 'image' }), CONTACT)?.content
    ).toEqual({ type: 'image', text: null, media: null });
  });

  it('flattens a location into readable text', () => {
    expect(
      normalizeMetaMessage(
        message({
          type: 'location',
          location: { latitude: -23.5, longitude: -46.6, name: 'Loja' },
        }),
        CONTACT
      )?.content
    ).toEqual({ type: 'location', text: 'Loja - -23.5,-46.6' });
  });

  it('routes a button reply by id and shows its title', () => {
    expect(
      normalizeMetaMessage(
        message({
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'opt_a', title: 'Cliente novo' },
          },
        }),
        CONTACT
      )?.content
    ).toEqual({ type: 'interactive', text: 'Cliente novo', replyId: 'opt_a' });
  });

  it('routes a template quick-reply tap, which uses its own envelope', () => {
    expect(
      normalizeMetaMessage(
        message({ type: 'button', button: { text: 'Sim', payload: 'YES' } }),
        CONTACT
      )?.content
    ).toEqual({ type: 'interactive', text: 'Sim', replyId: 'YES' });
  });

  it('falls back to the label when a template button carries no payload', () => {
    expect(
      normalizeMetaMessage(
        message({ type: 'button', button: { text: 'Sim' } }),
        CONTACT
      )?.content
    ).toEqual({ type: 'interactive', text: 'Sim', replyId: 'Sim' });
  });

  it('describes an unsupported type instead of dropping the message', () => {
    expect(
      normalizeMetaMessage(message({ type: 'contacts' }), CONTACT)?.content
    ).toEqual({
      type: 'text',
      text: '[Tipo de mensagem não compatível: contacts]',
    });
  });

  it('carries the quoted message id for a swipe reply', () => {
    expect(
      normalizeMetaMessage(
        message({ text: { body: 'sim' }, context: { id: 'wamid.parent' } }),
        CONTACT
      )?.replyToExternalId
    ).toBe('wamid.parent');
  });
});

describe('isMetaReaction', () => {
  it('identifies the type that is state, not a message', () => {
    expect(isMetaReaction(message({ type: 'reaction' }))).toBe(true);
    expect(isMetaReaction(message({ type: 'text' }))).toBe(false);
  });
});

describe('normalizeMetaStatus', () => {
  it('normalizes each tracked status', () => {
    for (const status of ['sent', 'delivered', 'read'] as const) {
      expect(
        normalizeMetaStatus({
          id: 'wamid.1',
          status,
          timestamp: TS,
          recipient_id: '1555',
        })
      ).toEqual({
        kind: 'status',
        provider: 'meta',
        externalMessageId: 'wamid.1',
        status,
        occurredAt: TS_ISO,
        failure: null,
      });
    }
  });

  it('keeps the reason Meta gave for a failed send', () => {
    expect(
      normalizeMetaStatus({
        id: 'wamid.1',
        status: 'failed',
        timestamp: TS,
        recipient_id: '1555',
        errors: [
          {
            code: 131049,
            title: 'Message not delivered',
            error_data: { details: 'Healthy ecosystem engagement' },
          },
        ],
      })?.failure
    ).toEqual({
      code: '131049',
      title: 'Message not delivered',
      details: 'Healthy ecosystem engagement',
    });
  });

  it('reads the reason only on failure, so a later status cannot clear it', () => {
    expect(
      normalizeMetaStatus({
        id: 'wamid.1',
        status: 'delivered',
        timestamp: TS,
        recipient_id: '1555',
        errors: [{ code: 1, title: 'stale' }],
      })?.failure
    ).toBeNull();
  });

  it('ignores a status outside the four the CRM tracks', () => {
    expect(
      normalizeMetaStatus({
        id: 'wamid.1',
        status: 'deleted',
        timestamp: TS,
        recipient_id: '1555',
      })
    ).toBeNull();
  });
});
