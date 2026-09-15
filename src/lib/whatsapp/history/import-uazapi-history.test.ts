import { describe, expect, it, vi } from 'vitest';

import type {
  UazapiChatPage,
  UazapiChatSummary,
  UazapiMessagePage,
} from '@/lib/whatsapp/providers/uazapi-client';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound/types';

import {
  HISTORY_CHATS_PER_BATCH,
  HISTORY_MESSAGES_PER_PAGE,
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

/**
 * A fake account. `chats` is the whole list the provider would page
 * through; `messages` maps a chat id to its whole history, newest first,
 * which the fake slices exactly as the real endpoint does.
 */
function reader(options: {
  chats: UazapiChatSummary[];
  messages?: Record<string, Record<string, unknown>[]>;
  failChats?: string[];
}) {
  const findChats = vi.fn(
    async ({ limit, offset }: { limit: number; offset: number }) =>
      ({
        chats: options.chats.slice(offset, offset + limit),
      }) satisfies UazapiChatPage
  );

  const findMessages = vi.fn(
    async ({
      chatId,
      limit,
      offset = 0,
    }: {
      chatId: string;
      limit: number;
      offset?: number;
    }) => {
      if (options.failChats?.includes(chatId)) throw new Error('upstream down');
      const all = options.messages?.[chatId] ?? [];
      const messages = all.slice(offset, offset + limit);
      return {
        messages,
        hasMore: offset + messages.length < all.length,
        nextOffset: offset + messages.length,
      } satisfies UazapiMessagePage;
    }
  );

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

function thread(chatId: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    messageRecord(`m-${i}`, { chatid: chatId })
  );
}

const START = { chatOffset: 0, messageOffset: 0 };

describe('importUazapiHistoryBatch — walking one chat to the end', () => {
  it('pages through a chat larger than one request', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: { 'c@s.whatsapp.net': thread('c@s.whatsapp.net', 450) },
    });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: sink.store,
      messagesPerPage: 200,
    });

    // 450 messages is three pages. Before this the import took the first
    // 200 and called the chat finished.
    expect(client.findMessages).toHaveBeenCalledTimes(3);
    expect(result.messagesImported).toBe(450);
    expect(result.nextChatOffset).toBe(1);

    // Not done yet: a short page of chats is not proof the account has no
    // more. Only an empty one is — which costs one extra request at the
    // very end and cannot truncate an import by accident.
    expect(result.done).toBe(false);

    const after = await importUazapiHistoryBatch({
      client,
      chatOffset: result.nextChatOffset,
      messageOffset: result.nextMessageOffset,
      store: collector().store,
    });
    expect(after.done).toBe(true);
  });

  it('asks for each page at the offset the last one ended on', async () => {
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: { 'c@s.whatsapp.net': thread('c@s.whatsapp.net', 250) },
    });

    await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
      messagesPerPage: 100,
    });

    const offsets = client.findMessages.mock.calls.map((c) => c[0].offset);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it('resumes a chat it was in the middle of', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: { 'c@s.whatsapp.net': thread('c@s.whatsapp.net', 300) },
    });

    await importUazapiHistoryBatch({
      client,
      chatOffset: 0,
      messageOffset: 200,
      store: sink.store,
      messagesPerPage: 200,
    });

    // Only what was left, not the 200 already stored.
    expect(sink.stored).toHaveLength(100);
    expect(client.findMessages.mock.calls[0][0].offset).toBe(200);
  });
});

describe('importUazapiHistoryBatch — bounding one request', () => {
  it('stops mid-chat when the message budget runs out', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: { 'c@s.whatsapp.net': thread('c@s.whatsapp.net', 1000) },
    });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: sink.store,
      messagesPerPage: 100,
      messageBudget: 250,
    });

    expect(result.done).toBe(false);
    expect(sink.stored.length).toBeGreaterThanOrEqual(250);
    // The cursor points back into the SAME chat, not past it.
    expect(result.nextChatOffset).toBe(0);
    expect(result.nextMessageOffset).toBe(sink.stored.length);
  });

  it('carries on from exactly where the budget stopped it', async () => {
    const history = thread('c@s.whatsapp.net', 500);
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: { 'c@s.whatsapp.net': history },
    });

    const all: string[] = [];
    let cursor = { ...START };

    for (let guard = 0; guard < 20; guard += 1) {
      const sink = collector();
      const result = await importUazapiHistoryBatch({
        client,
        ...cursor,
        store: sink.store,
        messagesPerPage: 100,
        messageBudget: 150,
      });
      all.push(...sink.stored.map((e) => e.externalMessageId));
      if (result.done) break;
      cursor = {
        chatOffset: result.nextChatOffset,
        messageOffset: result.nextMessageOffset,
      };
    }

    // Every message exactly once: nothing lost at a batch boundary, and
    // nothing fetched twice.
    expect(all).toHaveLength(500);
    expect(new Set(all).size).toBe(500);
  });

  it('stops after a page of chats even when they are small', async () => {
    const chats = Array.from({ length: 40 }, (_, i) =>
      chat(`c${i}@s.whatsapp.net`)
    );
    const client = reader({ chats });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
      chatsPerBatch: 8,
    });

    expect(result.chatsSeen).toBe(8);
    expect(result.nextChatOffset).toBe(8);
    expect(result.done).toBe(false);
  });
});

describe('importUazapiHistoryBatch — walking every chat', () => {
  it('reaches the last chat however many there are', async () => {
    const chats = Array.from({ length: 53 }, (_, i) =>
      chat(`c${i}@s.whatsapp.net`)
    );
    const messages = Object.fromEntries(
      chats.map((c) => [c.id, thread(c.id, 3)])
    );
    const client = reader({ chats, messages });

    const seen: string[] = [];
    let cursor = { ...START };

    for (let guard = 0; guard < 100; guard += 1) {
      const sink = collector();
      const result = await importUazapiHistoryBatch({
        client,
        ...cursor,
        store: sink.store,
        chatsPerBatch: 8,
      });
      seen.push(...sink.stored.map((e) => e.chat.externalId ?? ''));
      if (result.done) break;
      cursor = {
        chatOffset: result.nextChatOffset,
        messageOffset: result.nextMessageOffset,
      };
    }

    // No ceiling: the walk ends because the account ran out of chats.
    expect(new Set(seen).size).toBe(53);
  });

  it('is done only when the provider runs out of chats', async () => {
    const client = reader({ chats: [] });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
    });

    expect(result).toMatchObject({ done: true, chatsSeen: 0 });
    expect(client.findMessages).not.toHaveBeenCalled();
  });

  it('is not done just because a chats page came back full', async () => {
    const chats = Array.from({ length: HISTORY_CHATS_PER_BATCH }, (_, i) =>
      chat(`c${i}@s.whatsapp.net`)
    );
    const client = reader({ chats });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
    });

    expect(result.done).toBe(false);
  });
});

describe('importUazapiHistoryBatch — what it stores', () => {
  it('keeps our own half of the thread', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: {
        'c@s.whatsapp.net': [
          messageRecord('mine', {
            chatid: 'c@s.whatsapp.net',
            fromMe: true,
            text: 'ja respondi',
          }),
          messageRecord('theirs', { chatid: 'c@s.whatsapp.net' }),
        ],
      },
    });

    await importUazapiHistoryBatch({ client, ...START, store: sink.store });

    expect(sink.stored.map((e) => e.fromMe).sort()).toEqual([false, true]);
  });

  it('names a group thread from the chat listing', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('12345-67890@g.us', { name: 'Vendas SP' })],
      messages: {
        '12345-67890@g.us': [
          messageRecord('m-1', { chatid: '12345-67890@g.us' }),
        ],
      },
    });

    await importUazapiHistoryBatch({ client, ...START, store: sink.store });

    expect(sink.stored[0]?.chat).toMatchObject({
      externalId: '12345-67890@g.us',
      isGroup: true,
      name: 'Vendas SP',
    });
  });

  it('keeps a name the message itself carried', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('12345-67890@g.us', { name: 'from the listing' })],
      messages: {
        '12345-67890@g.us': [
          messageRecord('m-1', {
            chatid: '12345-67890@g.us',
            groupName: 'from the message',
          }),
        ],
      },
    });

    await importUazapiHistoryBatch({ client, ...START, store: sink.store });

    expect(sink.stored[0]?.chat.name).toBe('from the message');
  });

  it('defaults to a sane page size', async () => {
    const client = reader({ chats: [chat('c@s.whatsapp.net')] });

    await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
    });

    expect(client.findMessages.mock.calls[0][0].limit).toBe(
      HISTORY_MESSAGES_PER_PAGE
    );
  });
});

describe('importUazapiHistoryBatch — failures', () => {
  it('skips a chat it cannot read rather than losing the whole batch', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('broken@s.whatsapp.net'), chat('ok@s.whatsapp.net')],
      messages: { 'ok@s.whatsapp.net': [messageRecord('m-1')] },
      failChats: ['broken@s.whatsapp.net'],
    });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: sink.store,
    });

    expect(result.failedChats).toBe(1);
    expect(result.messagesImported).toBe(1);
  });

  it('moves past an unreadable chat instead of retrying it forever', async () => {
    const client = reader({
      chats: [chat('broken@s.whatsapp.net')],
      failChats: ['broken@s.whatsapp.net'],
    });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: collector().store,
    });

    // The cursor has to advance, or the next batch reads the same broken
    // chat and the import never finishes.
    expect(result.nextChatOffset).toBe(1);
    expect(result.nextMessageOffset).toBe(0);
  });

  it('skips a row the normalizer refuses without failing the chat', async () => {
    const sink = collector();
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: {
        'c@s.whatsapp.net': [
          { nothing: 'usable' },
          messageRecord('m-1', { chatid: 'c@s.whatsapp.net' }),
        ],
      },
    });

    const result = await importUazapiHistoryBatch({
      client,
      ...START,
      store: sink.store,
    });

    expect(result.messagesImported).toBe(1);
    expect(result.skippedMessages).toBe(1);
  });

  it('stops the batch when storing fails, so nothing is silently lost', async () => {
    const client = reader({
      chats: [chat('c@s.whatsapp.net')],
      messages: {
        'c@s.whatsapp.net': [
          messageRecord('m-1', { chatid: 'c@s.whatsapp.net' }),
        ],
      },
    });

    await expect(
      importUazapiHistoryBatch({
        client,
        ...START,
        store: async () => {
          throw new Error('database gone');
        },
      })
    ).rejects.toThrow('database gone');
  });
});
