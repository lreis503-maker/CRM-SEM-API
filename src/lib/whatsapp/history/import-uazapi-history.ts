/**
 * Backfilling what WhatsApp already knows.
 *
 * A seller who connects the CRM today should not start from an empty
 * inbox: the conversations that matter were already happening on the
 * phone. This walks the account's chats, newest activity first, and
 * stores what it finds.
 *
 * Three rules shape the design:
 *
 * 1. **Bounded.** One call does a page of chats and a capped number of
 *    messages per chat, then says where it stopped. A request that walks
 *    an entire WhatsApp account would outlive any serverless timeout, and
 *    a crash half-way would leave nothing.
 * 2. **Resumable.** The only cursor is a chat offset, so the caller can
 *    store one integer and carry on after a stop, a timeout, or a closed
 *    browser tab.
 * 3. **Inert.** Imported messages are records of things that already
 *    happened. `processInboundMessage` is told so, and skips every
 *    reaction — no unread, no automation, no AI reply, no outbound
 *    webhook. Firing those on a backfill would message real people about
 *    conversations that ended months ago.
 */

import { normalizeUazapiHistoryMessage } from '@/lib/whatsapp/inbound/uazapi-normalizer';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound/types';
import type {
  UazapiChatPage,
  UazapiChatSummary,
  UazapiMessagePage,
} from '@/lib/whatsapp/providers/uazapi-client';

/**
 * Chats per call. Small on purpose: each one costs a `/message/find`
 * round trip, and the batch has to finish inside a request.
 */
export const HISTORY_CHATS_PER_BATCH = 8;

/**
 * Messages per chat. The recent thread is what a seller opens a
 * conversation to read; going deeper multiplies cost for pages nobody
 * scrolls to.
 */
export const HISTORY_MESSAGES_PER_CHAT = 200;

/**
 * A ceiling on how far an import will ever walk. An account with tens of
 * thousands of chats would otherwise import forever, and the tail is
 * years-old threads.
 */
export const HISTORY_MAX_CHATS = 600;

/** The slice of the instance client a backfill needs. Reads only. */
export interface UazapiHistoryReader {
  findChats(input: { limit: number; offset: number }): Promise<UazapiChatPage>;
  findMessages(input: {
    chatId: string;
    limit: number;
  }): Promise<UazapiMessagePage>;
}

export interface UazapiHistoryBatchInput {
  client: UazapiHistoryReader;
  /** Chats already walked by previous batches. */
  chatOffset: number;
  /**
   * Stores one message. A failure here aborts the batch: the caller can
   * resume from the same offset, and going on would quietly lose rows.
   */
  store(event: NormalizedInboundMessage): Promise<void>;
  chatsPerBatch?: number;
  messagesPerChat?: number;
  maxChats?: number;
}

export interface UazapiHistoryBatchResult {
  /** Chats walked in this batch. */
  chatsSeen: number;
  messagesImported: number;
  /** Rows the normalizer could not read. */
  skippedMessages: number;
  /** Chats whose messages could not be read at all. */
  failedChats: number;
  /** Where the next batch should start. */
  nextChatOffset: number;
  /** True when there is nothing left to walk. */
  done: boolean;
}

/**
 * The chat listing knows the group's subject; a stored message often does
 * not. Merging them here keeps the normalizer honest about what was in
 * the payload while still giving the thread a readable name.
 */
function withChatName(
  event: NormalizedInboundMessage,
  chat: UazapiChatSummary
): NormalizedInboundMessage {
  if (!event.chat.isGroup || event.chat.name !== null) return event;

  return { ...event, chat: { ...event.chat, name: chat.name } };
}

export async function importUazapiHistoryBatch(
  input: UazapiHistoryBatchInput
): Promise<UazapiHistoryBatchResult> {
  const chatsPerBatch = input.chatsPerBatch ?? HISTORY_CHATS_PER_BATCH;
  const messagesPerChat = input.messagesPerChat ?? HISTORY_MESSAGES_PER_CHAT;
  const maxChats = input.maxChats ?? HISTORY_MAX_CHATS;

  if (input.chatOffset >= maxChats) {
    return {
      chatsSeen: 0,
      messagesImported: 0,
      skippedMessages: 0,
      failedChats: 0,
      nextChatOffset: input.chatOffset,
      done: true,
    };
  }

  const { chats } = await input.client.findChats({
    limit: chatsPerBatch,
    offset: input.chatOffset,
  });

  let messagesImported = 0;
  let skippedMessages = 0;
  let failedChats = 0;

  for (const chat of chats) {
    let page: UazapiMessagePage;
    try {
      page = await input.client.findMessages({
        chatId: chat.id,
        limit: messagesPerChat,
      });
    } catch {
      // One unreadable chat — deleted, or a thread the provider chokes
      // on — must not cost the seller every other conversation in the
      // page. It is counted so the failure is visible, not silent.
      failedChats += 1;
      continue;
    }

    // Oldest first, so a thread reads in order even if the import is
    // interrupted part-way through it.
    for (const record of [...page.messages].reverse()) {
      const result = normalizeUazapiHistoryMessage(record);
      if (result.outcome !== 'event') {
        // An ignored row (a newsletter post) and an unreadable one are
        // both simply absent from the thread; neither is worth failing
        // an import over.
        if (result.outcome === 'quarantine') skippedMessages += 1;
        continue;
      }

      for (const event of result.events) {
        if (event.kind !== 'message') continue;
        await input.store(withChatName(event, chat));
        messagesImported += 1;
      }
    }
  }

  const nextChatOffset = input.chatOffset + chats.length;

  return {
    chatsSeen: chats.length,
    messagesImported,
    skippedMessages,
    failedChats,
    nextChatOffset,
    // A short page means the account has no more chats; the ceiling is
    // the other way the walk ends.
    done: chats.length < chatsPerBatch || nextChatOffset >= maxChats,
  };
}
