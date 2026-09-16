/**
 * Fixtures captured from a real UAZAPI installation.
 *
 * The supplied OpenAPI documents a `{ event, instance, data }` envelope.
 * Nothing that actually arrived looked like that: the event name is in
 * `EventType`, the instance is named rather than identified, and there is
 * no `data` key at all — a message is under `message`, a read receipt
 * under `event` beside a top-level `state`, and a connection change under
 * `instance`.
 *
 * These payloads are the quarantined samples from the first live
 * deployment, with credentials already redacted by the quarantine writer.
 * They are the regression guard: the documented shape is a guess, this is
 * evidence.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeUazapiWebhook,
  uazapiInstanceIdOf,
  uazapiInstanceNameOf,
} from './uazapi-normalizer';
import type {
  NormalizedConnectionUpdate,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from './types';

const INBOUND_TEXT = {
  chat: {
    id: 'rf24e2c570ae0d4',
    owner: '5516994306261',
    phone: '15553541127',
    wa_chatid: '15553541127@s.whatsapp.net',
    wa_chatlid: '52884670537922@lid',
    wa_isGroup: false,
    wa_unreadCount: 1,
    wa_lastMessageTextVote: 'ola',
  },
  owner: '5516994306261',
  token: '[redacted]',
  BaseUrl: 'https://crmvortex.uazapi.com',
  message: {
    id: '5516994306261:6C33157AE4F425E8E1',
    text: 'ola',
    type: 'text',
    owner: '5516994306261',
    chatid: '15553541127@s.whatsapp.net',
    edited: '',
    fromMe: false,
    quoted: '',
    sender: '52884670537922@lid',
    source: 'desktop',
    status: '',
    chatlid: '52884670537922@lid',
    content: 'ola',
    isGroup: false,
    mediaType: '',
    messageid: '6C33157AE4F425E8E1',
    sender_pn: '15553541127@s.whatsapp.net',
    senderName: '',
    sender_lid: '52884670537922@lid',
    messageType: 'Conversation',
    wasSentByApi: false,
    messageTimestamp: 1789481126000,
  },
  EventType: 'messages',
  chatSource: 'updated',
  instanceName: 'wacrm-423cf543-6117',
};

const DELIVERY_RECEIPT = {
  type: 'ReadReceipt',
  event: {
    Chat: '5516994306261@s.whatsapp.net',
    Type: 'Delivered',
    Sender: '5516994306261@s.whatsapp.net',
    chatid: '5516994306261@s.whatsapp.net',
    IsGroup: false,
    chatlid: '129481167650847@lid',
    IsFromMe: true,
    Timestamp: 1789481127,
    sender_pn: '5516994306261@s.whatsapp.net',
    MessageIDs: ['2A5F50DD73B9312F636C'],
    sender_lid: '129481167650847@lid',
  },
  owner: '5516994306261',
  state: 'Delivered',
  token: '[redacted]',
  BaseUrl: 'https://crmvortex.uazapi.com',
  EventType: 'messages_update',
  instanceName: 'wacrm-423cf543-6117',
};

const CONNECTED = {
  owner: '5516994306261',
  token: '[redacted]',
  BaseUrl: 'https://crmvortex.uazapi.com',
  event_id: '[redacted]',
  instance: { name: 'wacrm-423cf543-6117', status: 'connected' },
  EventType: 'connection',
  instanceName: 'wacrm-423cf543-6117',
};

const CONNECTING = {
  owner: '',
  token: '[redacted]',
  BaseUrl: 'https://crmvortex.uazapi.com',
  event_id: '[redacted]',
  instance: {
    name: 'wacrm-423cf543-6117',
    qrcode: '[redacted]',
    status: 'connecting',
  },
  EventType: 'connection',
  instanceName: 'wacrm-423cf543-6117',
};

function events(result: ReturnType<typeof normalizeUazapiWebhook>) {
  expect(result.outcome).toBe('event');
  return (result as { events: unknown[] }).events;
}

describe('a real inbound text message', () => {
  it('is recognized even though there is no data wrapper', () => {
    const [event] = events(
      normalizeUazapiWebhook(INBOUND_TEXT)
    ) as NormalizedInboundMessage[];

    expect(event).toMatchObject({
      kind: 'message',
      provider: 'uazapi',
      externalMessageId: '6C33157AE4F425E8E1',
      fromMe: false,
      isGroup: false,
      replyToExternalId: null,
      content: { type: 'text', text: 'ola' },
    });
  });

  it('reads the sender phone and keeps the LID as the stable id', () => {
    const [event] = events(
      normalizeUazapiWebhook(INBOUND_TEXT)
    ) as NormalizedInboundMessage[];

    expect(event.sender).toMatchObject({
      phone: '15553541127',
      externalId: '52884670537922@lid',
      externalIdKind: 'lid',
    });
  });

  it('reads the millisecond timestamp as the real send time', () => {
    const [event] = events(
      normalizeUazapiWebhook(INBOUND_TEXT)
    ) as NormalizedInboundMessage[];

    expect(event.occurredAt).toBe(new Date(1789481126000).toISOString());
  });

  it('maps the protobuf type name the provider actually sends', () => {
    // `Conversation`, not `text` — the contract shows the latter.
    expect(INBOUND_TEXT.message.messageType).toBe('Conversation');
    const [event] = events(
      normalizeUazapiWebhook(INBOUND_TEXT)
    ) as NormalizedInboundMessage[];
    expect(event.content.type).toBe('text');
  });
});

describe('a real delivery receipt', () => {
  it('is recognized from the state beside the envelope', () => {
    const [event] = events(
      normalizeUazapiWebhook(DELIVERY_RECEIPT)
    ) as NormalizedStatusUpdate[];

    expect(event).toMatchObject({
      kind: 'status',
      provider: 'uazapi',
      externalMessageId: '2A5F50DD73B9312F636C',
      status: 'delivered',
    });
  });

  it('reads the second-based timestamp receipts use', () => {
    const [event] = events(
      normalizeUazapiWebhook(DELIVERY_RECEIPT)
    ) as NormalizedStatusUpdate[];

    // The same delivery carries milliseconds on a message and seconds
    // here, so the unit has to be detected rather than assumed.
    expect(event.occurredAt).toBe(new Date(1789481127 * 1000).toISOString());
  });

  it('acknowledges every message the receipt covers', () => {
    const batched = {
      ...DELIVERY_RECEIPT,
      state: 'Read',
      event: {
        ...DELIVERY_RECEIPT.event,
        Type: 'Read',
        MessageIDs: ['AAA', 'BBB', 'CCC'],
      },
    };

    const result = events(
      normalizeUazapiWebhook(batched)
    ) as NormalizedStatusUpdate[];

    // Reading a conversation marks a run of messages at once; taking only
    // the first would leave the rest stuck on "sent" forever.
    expect(result.map((e) => e.externalMessageId)).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ]);
    expect(result.every((e) => e.status === 'read')).toBe(true);
  });
});

describe('a real connection change', () => {
  it('reads the state from inside the instance object', () => {
    const [event] = events(
      normalizeUazapiWebhook(CONNECTED)
    ) as NormalizedConnectionUpdate[];

    expect(event).toMatchObject({
      kind: 'connection',
      provider: 'uazapi',
      status: 'connected',
      phone: '5516994306261',
    });
  });

  it('reads the pairing state, and never keeps the QR code', () => {
    const [event] = events(
      normalizeUazapiWebhook(CONNECTING)
    ) as NormalizedConnectionUpdate[];

    expect(event.status).toBe('connecting');
    expect(event.phone).toBeNull();
    expect(JSON.stringify(event)).not.toContain('qrcode');
  });
});

describe('instance identity as the provider actually sends it', () => {
  it('names the instance rather than identifying it', () => {
    for (const payload of [INBOUND_TEXT, DELIVERY_RECEIPT, CONNECTED]) {
      expect(uazapiInstanceNameOf(payload)).toBe('wacrm-423cf543-6117');
      // No id anywhere, which is why matching on the id alone never fired.
      expect(uazapiInstanceIdOf(payload)).toBeNull();
    }
  });
});
