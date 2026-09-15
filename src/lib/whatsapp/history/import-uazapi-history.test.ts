import { describe, expect, it, vi } from 'vitest';

import type {
  UazapiChatPage,
  UazapiChatSummary,
  UazapiMessagePage,
} from '@/lib/whatsapp/providers/uazapi-client';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound/types';

import {
  HISTORY_CHATS_PER_BATCH,
  importUazapiHistoryBatch,
} from './import-uazapi-history';

function chat(id: string, overrides: Partial<UazapiChatSummary> = {}) {
  return { id, name: null, isGroup: id.endsWith('@g.us'), ...overrides };
}

function messageRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    messageid: id,
    chatid: '5511999999999@s.whatsapp.net',
    sender_pn: '5511999999999@s.whatsapp.net',
    senderName: 'Ada',
    fromMe: false,
    messageType: 'text',
    messageTimestamp: 1789000000000,
    text: 'oi',
    ...overrides,
  };
}

function reader(options: {
  pages: UazapiChatSummary[][];
  messages?: Record<string, Record<string, unknown>[]>;
  failChats?: string[];
}) {
  const findChats = vi.fn(
    async ({ offset }: { limit: number; offset: number }) => {
      const size = options.pages[0]?.length ?? 0;
      const index = size === 0 ? 0 : Math.floor(offset / size);
      return { chats: options.pages[index] ?? [] } satisfies UazapiChatPage;
    }
  );

  const findMessages = vi.fn(async ({ chatId }: { chatId: string }) => {
    if (options.failChats?.includes(chatId)) throw new Error('upstream down');
    return {
      messages: options.messages?.[chatId] ?? [],
    } satisfies UazapiMessagePage;
  });

  return { findChats, findMessages };
}

function collector() {
  const stored: NormalizedInboundMessage[] = [];
  return {
    stored,
    store: vi.fn(async (event: NormalizedInboundMessage) => {
      stored.push(event);
    }),
  };
}

describe('importUazapiHistoryBatch', () => {
  it('walks the chats from where the last batch stopped', async () => {
    const client = reader({ pages: [[chat('a@s.whatsapp.net')]] });

    await importUazapiHistoryBatch({
      client,
      chatOffset: 40,
      store: collector().store,
    });

    expect(client.findChats).toHaveBeenCalledWith({
      limit: HISTORY_CHATS_PER_BATCH,
      offset: 40,
    });
  });

  it('stores a chat oldest first, however the provider returned it', async () => {
    const sink = collector();
    const client = reader({
      pages: [[chat('5511999999999@s.whatsapp.net')]],
      messages: {
        // Newest first, which is what '-messageTimestamp' asks for.
        '5511999999999@s.whatsapp.net': [
          messageRecord('newest', { fromMe: true, text: 'ja respondi' }),
          messageRecord('oldest'),
        ],
      },
    });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: sink.store,
    });

    expect(result.messagesImported).toBe(2);
    // Written in the order they were said, so a thread interrupted
    // half-way still reads from the top.
    expect(sink.stored.map((event) => event.externalMessageId)).toEqual([
      'oldest',
      'newest',
    ]);
    // Our own half of the thread is the point: a seller reading the
    // history needs to see what was already answered.
    expect(sink.stored[1]?.fromMe).toBe(true);
  });

  it('names a group thread from the chat listing', async () => {
    const sink = collector();
    const client = reader({
      pages: [[chat('12345-67890@g.us', { name: 'Vendas SP' })]],
      messages: {
        '12345-67890@g.us': [
          // The stored row carries no group subject; only the listing does.
          messageRecord('m-1', { chatid: '12345-67890@g.us' }),
        ],
      },
    });

    await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: sink.store,
    });

    expect(sink.stored[0]?.chat).toMatchObject({
      externalId: '12345-67890@g.us',
      isGroup: true,
      name: 'Vendas SP',
    });
  });

  it('keeps a name the message itself carried', async () => {
    const sink = collector();
    const client = reader({
      pages: [[chat('12345-67890@g.us', { name: 'from the listing' })]],
      messages: {
        '12345-67890@g.us': [
          messageRecord('m-1', {
            chatid: '12345-67890@g.us',
            groupName: 'from the message',
          }),
        ],
      },
    });

    await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: sink.store,
    });

    expect(sink.stored[0]?.chat.name).toBe('from the message');
  });

  it('asks for the newest messages of each chat, bounded', async () => {
    const client = reader({ pages: [[chat('a@s.whatsapp.net')]] });

    await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: collector().store,
      messagesPerChat: 25,
    });

    expect(client.findMessages).toHaveBeenCalledWith({
      chatId: 'a@s.whatsapp.net',
      limit: 25,
    });
  });

  it('reports that it is done when a page comes back empty', async () => {
    const client = reader({ pages: [[]] });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: collector().store,
    });

    expect(result).toMatchObject({ done: true, chatsSeen: 0 });
    expect(client.findMessages).not.toHaveBeenCalled();
  });

  it('reports more work when the page came back full', async () => {
    const full = Array.from({ length: HISTORY_CHATS_PER_BATCH }, (_, index) =>
      chat(`c${index}@s.whatsapp.net`)
    );
    const client = reader({ pages: [full] });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: collector().store,
    });

    expect(result.done).toBe(false);
    expect(result.nextChatOffset).toBe(HISTORY_CHATS_PER_BATCH);
  });

  it('stops at the chat ceiling instead of walking forever', async () => {
    const full = Array.from({ length: HISTORY_CHATS_PER_BATCH }, (_, index) =>
      chat(`c${index}@s.whatsapp.net`)
    );
    const client = reader({ pages: [full] });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: HISTORY_CHATS_PER_BATCH,
      store: collector().store,
      maxChats: HISTORY_CHATS_PER_BATCH * 2,
    });

    expect(result.done).toBe(true);
  });

  it('skips a chat it cannot read rather than losing the whole batch', async () => {
    const sink = collector();
    const client = reader({
      pages: [[chat('broken@s.whatsapp.net'), chat('ok@s.whatsapp.net')]],
      messages: { 'ok@s.whatsapp.net': [messageRecord('m-1')] },
      failChats: ['broken@s.whatsapp.net'],
    });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: sink.store,
    });

    expect(result.failedChats).toBe(1);
    expect(result.messagesImported).toBe(1);
  });

  it('skips a row the normalizer refuses without failing the chat', async () => {
    const sink = collector();
    const client = reader({
      pages: [[chat('5511999999999@s.whatsapp.net')]],
      messages: {
        '5511999999999@s.whatsapp.net': [
          { nothing: 'usable' },
          messageRecord('m-1'),
        ],
      },
    });

    const result = await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      store: sink.store,
    });

    expect(result.messagesImported).toBe(1);
    expect(result.skippedMessages).toBe(1);
  });

  it('stops the batch when storing fails, so nothing is silently lost', async () => {
    const client = reader({
      pages: [[chat('5511999999999@s.whatsapp.net')]],
      messages: { '5511999999999@s.whatsapp.net': [messageRecord('m-1')] },
    });

    await expect(
      importUazapiHistoryBatch({
        client,
        chatOffset: 0,
        store: async () => {
          throw new Error('database gone');
        },
      })
    ).rejects.toThrow('database gone');
  });
});
