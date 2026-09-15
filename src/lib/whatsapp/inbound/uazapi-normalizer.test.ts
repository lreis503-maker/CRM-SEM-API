import { describe, expect, it } from 'vitest';

import {
  normalizeUazapiWebhook,
  uazapiInstanceIdOf,
} from './uazapi-normalizer';
import type {
  NormalizedConnectionUpdate,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from './types';

const TS_MS = 1789000000000;
const TS_ISO = new Date(TS_MS).toISOString();

function messagesEvent(data: Record<string, unknown>, event = 'messages') {
  return { event, instance: 'i-1', data };
}

function textData(overrides: Record<string, unknown> = {}) {
  return {
    messageid: '3EB0538DA65A59F6D8A251',
    chatid: '5511999999999@s.whatsapp.net',
    sender: '5511999999999@s.whatsapp.net',
    sender_pn: '5511999999999@s.whatsapp.net',
    senderName: 'Ada',
    fromMe: false,
    isGroup: false,
    messageType: 'text',
    messageTimestamp: TS_MS,
    text: 'oi',
    ...overrides,
  };
}

function expectMessage(result: ReturnType<typeof normalizeUazapiWebhook>) {
  expect(result.outcome).toBe('event');
  const event = (result as { event: NormalizedInboundMessage }).event;
  expect(event.kind).toBe('message');
  return event;
}

describe('normalizeUazapiWebhook — messages', () => {
  it('normalizes a text message', () => {
    const event = expectMessage(
      normalizeUazapiWebhook(messagesEvent(textData()))
    );

    expect(event).toMatchObject({
      kind: 'message',
      provider: 'uazapi',
      externalMessageId: '3EB0538DA65A59F6D8A251',
      occurredAt: TS_ISO,
      fromMe: false,
      isGroup: false,
      content: { type: 'text', text: 'oi' },
      replyToExternalId: null,
    });
    expect(event.sender).toMatchObject({
      phone: '5511999999999',
      profileName: 'Ada',
    });
  });

  it('accepts the EventType spelling the contract also documents', () => {
    const result = normalizeUazapiWebhook({
      EventType: 'messages',
      instance: 'i-1',
      data: textData(),
    });

    expect(result.outcome).toBe('event');
  });

  it('accepts the singular event names the contract also documents', () => {
    expect(
      normalizeUazapiWebhook(messagesEvent(textData(), 'message')).outcome
    ).toBe('event');
  });

  it('carries a quoted message id', () => {
    const event = expectMessage(
      normalizeUazapiWebhook(messagesEvent(textData({ quoted: 'parent-id' })))
    );
    expect(event.replyToExternalId).toBe('parent-id');
  });

  it('falls back to the internal id when no provider id is present', () => {
    const data = textData();
    delete (data as Record<string, unknown>).messageid;
    const event = expectMessage(
      normalizeUazapiWebhook(messagesEvent({ ...data, id: 'r1a2b3c' }))
    );
    expect(event.externalMessageId).toBe('r1a2b3c');
  });
});

describe('normalizeUazapiWebhook — media', () => {
  it.each([
    ['image', 'image', 'image/jpeg'],
    ['video', 'video', 'video/mp4'],
    ['audio', 'audio', 'audio/ogg'],
    ['document', 'document', 'application/pdf'],
  ])('normalizes %s delivered with a link', (messageType, expected, mime) => {
    const event = expectMessage(
      normalizeUazapiWebhook(
        messagesEvent(
          textData({
            messageType,
            text: 'legenda',
            fileURL: 'https://api.uazapi.com/files/a',
            mimetype: mime,
          })
        )
      )
    );

    expect(event.content).toEqual({
      type: expected,
      text: 'legenda',
      media: {
        externalMediaId: '3EB0538DA65A59F6D8A251',
        locator: 'provider_url',
        locatorValue: 'https://api.uazapi.com/files/a',
        mimeType: mime,
        fileName: null,
        fileSize: null,
      },
    });
  });

  it('points at the message id when no link was delivered', () => {
    const event = expectMessage(
      normalizeUazapiWebhook(
        messagesEvent(textData({ messageType: 'image', text: null }))
      )
    );

    // The route downloads it through /message/download instead.
    expect(event.content).toMatchObject({
      type: 'image',
      media: {
        locator: 'provider_id',
        locatorValue: '3EB0538DA65A59F6D8A251',
      },
    });
  });

  it('treats a sticker as an image and a voice note as audio', () => {
    expect(
      expectMessage(
        normalizeUazapiWebhook(
          messagesEvent(textData({ messageType: 'sticker' }))
        )
      ).content.type
    ).toBe('image');

    expect(
      expectMessage(
        normalizeUazapiWebhook(messagesEvent(textData({ messageType: 'ptt' })))
      ).content.type
    ).toBe('audio');
  });

  it('carries a document file name when one was supplied', () => {
    const event = expectMessage(
      normalizeUazapiWebhook(
        messagesEvent(
          textData({
            messageType: 'document',
            fileURL: 'https://api.uazapi.com/files/a.pdf',
            docName: 'Contrato.pdf',
          })
        )
      )
    );

    expect(event.content).toMatchObject({
      media: { fileName: 'Contrato.pdf' },
    });
  });
});

describe('normalizeUazapiWebhook — sender identity', () => {
  it('uses the phone and attaches the LID when both are present', () => {
    const event = expectMessage(
      normalizeUazapiWebhook(
        messagesEvent(textData({ sender_lid: '182736@lid' }))
      )
    );

    expect(event.sender).toMatchObject({
      phone: '5511999999999',
      externalId: '182736@lid',
      externalIdKind: 'lid',
    });
  });

  it('resolves a LID-only sender with no phone at all', () => {
    // A LID-only conversation carries no phone anywhere, chat id included.
    const data = textData({
      chatid: '182736@lid',
      sender: '182736@lid',
      sender_lid: '182736@lid',
    });
    delete (data as Record<string, unknown>).sender_pn;

    const event = expectMessage(normalizeUazapiWebhook(messagesEvent(data)));

    expect(event.sender).toMatchObject({
      phone: '',
      externalId: '182736@lid',
      externalIdKind: 'lid',
    });
  });

  it('falls back to the chat JID as a usable identity', () => {
    const data = textData();
    delete (data as Record<string, unknown>).sender_pn;
    delete (data as Record<string, unknown>).sender;

    const event = expectMessage(normalizeUazapiWebhook(messagesEvent(data)));

    expect(event.sender.phone).toBe('5511999999999');
  });

  it('quarantines a message with no identity at all', () => {
    const data = textData();
    for (const key of ['sender', 'sender_pn', 'sender_lid', 'chatid']) {
      delete (data as Record<string, unknown>)[key];
    }

    expect(normalizeUazapiWebhook(messagesEvent(data))).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'missing_sender_identity',
    });
  });
});

describe('normalizeUazapiWebhook — messages we must not act on', () => {
  it('ignores our own outbound echo', () => {
    expect(
      normalizeUazapiWebhook(messagesEvent(textData({ fromMe: true })))
    ).toEqual({ outcome: 'ignored', reason: 'from_me' });
  });

  it('ignores an API-sent message even when the filter let it through', () => {
    expect(
      normalizeUazapiWebhook(messagesEvent(textData({ wasSentByApi: true })))
    ).toEqual({ outcome: 'ignored', reason: 'sent_by_api' });
  });

  it('ignores a group message by flag and by chat id', () => {
    expect(
      normalizeUazapiWebhook(messagesEvent(textData({ isGroup: true })))
    ).toEqual({ outcome: 'ignored', reason: 'group' });

    expect(
      normalizeUazapiWebhook(
        messagesEvent(textData({ isGroup: false, chatid: '12345-67890@g.us' }))
      )
    ).toEqual({ outcome: 'ignored', reason: 'group' });
  });

  it('ignores a newsletter post', () => {
    expect(
      normalizeUazapiWebhook(
        messagesEvent(textData({ chatid: '1203@newsletter' }))
      )
    ).toEqual({ outcome: 'ignored', reason: 'not_direct_chat' });
  });
});

describe('normalizeUazapiWebhook — statuses', () => {
  it.each([
    ['Sent', 'sent'],
    ['Delivered', 'delivered'],
    ['Read', 'read'],
    ['Failed', 'failed'],
  ])('maps %s onto the CRM status', (provider, expected) => {
    const result = normalizeUazapiWebhook({
      event: 'messages_update',
      instance: 'i-1',
      data: {
        messageid: 'm-1',
        status: provider,
        messageTimestamp: TS_MS,
        fromMe: true,
      },
    });

    expect(result.outcome).toBe('event');
    const event = (result as { event: NormalizedStatusUpdate }).event;
    expect(event).toMatchObject({
      kind: 'status',
      provider: 'uazapi',
      externalMessageId: 'm-1',
      status: expected,
      occurredAt: TS_ISO,
    });
  });

  it('keeps the provider reason on a failed status', () => {
    const result = normalizeUazapiWebhook({
      event: 'messages_update',
      instance: 'i-1',
      data: {
        messageid: 'm-1',
        status: 'Failed',
        error: 'WhatsApp server rejected the message',
        messageTimestamp: TS_MS,
      },
    });

    expect((result as { event: NormalizedStatusUpdate }).event.failure).toEqual(
      {
        code: null,
        title: 'WhatsApp server rejected the message',
        details: null,
      }
    );
  });

  it('ignores a lifecycle state the CRM does not track', () => {
    expect(
      normalizeUazapiWebhook({
        event: 'messages_update',
        instance: 'i-1',
        data: { messageid: 'm-1', status: 'Queued' },
      })
    ).toEqual({ outcome: 'ignored', reason: 'untracked_status' });
  });

  it('quarantines a status update with no message id', () => {
    expect(
      normalizeUazapiWebhook({
        event: 'messages_update',
        instance: 'i-1',
        data: { status: 'Read' },
      })
    ).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'missing_message_id',
    });
  });
});

describe('normalizeUazapiWebhook — connection', () => {
  it.each(['disconnected', 'connecting', 'connected', 'hibernated'] as const)(
    'maps the %s state',
    (status) => {
      const result = normalizeUazapiWebhook({
        event: 'connection',
        instance: 'i-1',
        data: { status, profileName: 'Loja', profilePicUrl: 'https://x/y.jpg' },
      });

      expect(result.outcome).toBe('event');
      const event = (result as { event: NormalizedConnectionUpdate }).event;
      expect(event).toMatchObject({
        kind: 'connection',
        provider: 'uazapi',
        status,
        displayName: 'Loja',
        avatarUrl: 'https://x/y.jpg',
      });
    }
  );

  it('quarantines an unrecognized connection state', () => {
    expect(
      normalizeUazapiWebhook({
        event: 'connection',
        instance: 'i-1',
        data: { status: 'something_new' },
      })
    ).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'unknown_connection_state',
    });
  });
});

describe('normalizeUazapiWebhook — payloads that do not match the contract', () => {
  it('quarantines a body that is not an object', () => {
    for (const body of ['a string', 42, null, [1, 2]]) {
      expect(normalizeUazapiWebhook(body)).toMatchObject({
        outcome: 'quarantine',
        reasonCode: 'body_not_an_object',
      });
    }
  });

  it('quarantines an event name the CRM never subscribed to', () => {
    expect(
      normalizeUazapiWebhook({ event: 'presence', instance: 'i-1', data: {} })
    ).toMatchObject({ outcome: 'quarantine', reasonCode: 'unknown_event' });
  });

  it('quarantines a subscribed event with no data', () => {
    expect(
      normalizeUazapiWebhook({ event: 'messages', instance: 'i-1' })
    ).toMatchObject({ outcome: 'quarantine', reasonCode: 'missing_data' });
  });

  it('quarantines a message type it cannot map, never guessing', () => {
    const result = normalizeUazapiWebhook(
      messagesEvent(textData({ messageType: 'pollCreationMessage' }))
    );

    expect(result).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'unknown_message_type',
      eventName: 'messages',
    });
  });

  it('quarantines a message with no id', () => {
    const data = textData();
    delete (data as Record<string, unknown>).messageid;

    expect(normalizeUazapiWebhook(messagesEvent(data))).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'missing_message_id',
    });
  });

  it('reports the event name so quarantine rows are groupable', () => {
    const result = normalizeUazapiWebhook({
      event: 'presence',
      instance: 'i-1',
      data: {},
    });
    expect((result as { eventName: string }).eventName).toBe('presence');
  });
});

describe('uazapiInstanceIdOf', () => {
  it('reads the instance the event claims to come from', () => {
    expect(uazapiInstanceIdOf(messagesEvent(textData()))).toBe('i-1');
  });

  it('returns null when the payload names no instance', () => {
    expect(uazapiInstanceIdOf({ event: 'messages', data: {} })).toBeNull();
    expect(uazapiInstanceIdOf('nope')).toBeNull();
  });
});
