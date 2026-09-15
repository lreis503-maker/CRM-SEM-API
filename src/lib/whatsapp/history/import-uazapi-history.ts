/**
 * Backfilling what WhatsApp already knows.
 *
 * A seller who connects the CRM today should not start from an empty
 * inbox: the conversations that matter were already happening on the
 * phone. This walks the account's chats and stores everything it finds —
 * every chat, and every message of each chat, however long the thread.
 *
 * Three rules shape the design:
 *
 * 1. **Bounded per request, unbounded overall.** One call does a page of
 *    chats and stops once it has stored a set number of messages, then
 *    says exactly where it stopped. A request that walked an entire
 *    WhatsApp account would outlive any serverless timeout; a walk that
 *    gave up after a fixed number of chats would leave the account
 *    permanently half-imported, which is worse.
 * 2. **Resumable to the message.** The cursor is two numbers — chats
 *    finished, and pages taken inside the chat currently being read — so
 *    a stop, a timeout or a closed browser tab costs nothing, even in the
 *    middle of a thread with thousands of messages.
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

/** Chats listed per call. Also the most one request will finish. */
export const HISTORY_CHATS_PER_BATCH = 8;

/** Messages per `/message/find` call, within one chat. */
export const HISTORY_MESSAGES_PER_PAGE = 200;

/**
 * How many messages one request will store before handing the cursor
 * back. Every stored message is several database round trips, so this —
 * not the number of chats — is what actually decides how long a request
 * takes. Low enough to always finish, high enough that the overhead of
 * starting a batch stays a small share of the work.
 */
export const HISTORY_MESSAGE_BUDGET = 500;

/** The slice of the instance client a backfill needs. Reads only. */
export interface UazapiHistoryReader {
  findChats(input: { limit: number; offset: number }): Promise<UazapiChatPage>;
  findMessages(input: {
    chatId: string;
    limit: number;
    offset?: number;
  }): Promise<UazapiMessagePage>;
}

export interface UazapiHistoryBatchInput {
  client: UazapiHistoryReader;
  /** Chats already walked to the end by previous batches. */
  chatOffset: number;
  /**
   * How far into the chat at `chatOffset` the last batch got. Zero when
   * starting that chat from its newest message.
   */
  messageOffset: number;
  /**
   * Stores one message. A failure here aborts the batch: the caller can
   * resume from the same cursor, and going on would quietly lose rows.
   */
  store(event: NormalizedInboundMessage): Promise<void>;
  chatsPerBatch?: number;
  messagesPerPage?: number;
  messageBudget?: number;
}

export interface UazapiHistoryBatchResult {
  /** Chats walked to the end in this batch. */
  chatsSeen: number;
  messagesImported: number;
  /** Rows the normalizer could not read. */
  skippedMessages: number;
  /** Chats whose messages could not be read at all. */
  failedChats: number;
  /** Where the next batch should start. */
  nextChatOffset: number;
  nextMessageOffset: number;
  /** True only when the provider has no more chats to list. */
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
  const messagesPerPage = input.messagesPerPage ?? HISTORY_MESSAGES_PER_PAGE;
  const messageBudget = input.messageBudget ?? HISTORY_MESSAGE_BUDGET;

  const { chats } = await input.client.findChats({
    limit: chatsPerBatch,
    offset: input.chatOffset,
  });

  let chatsSeen = 0;
  let messagesImported = 0;
  let skippedMessages = 0;
  let failedChats = 0;

  // Where we are right now, moved forward as chats are finished so that
  // an early return always hands back a truthful cursor.
  let chatOffset = input.chatOffset;
  // Only the FIRST chat of this batch can be resumed mid-thread; every
  // chat after it starts at its newest message.
  let messageOffset = input.messageOffset;

  for (const chat of chats) {
    let offset = messageOffset;
    let exhausted = false;
    let budgetSpent = false;

    while (!exhausted && !budgetSpent) {
      let page: UazapiMessagePage;
      try {
        page = await input.client.findMessages({
          chatId: chat.id,
          limit: messagesPerPage,
          offset,
        });
      } catch {
        // One unreadable chat — deleted, or a thread the provider chokes
        // on — must not cost the seller every other conversation. It is
        // counted so the failure is visible, and treated as finished so
        // the next batch moves past it instead of retrying it forever.
        failedChats += 1;
        exhausted = true;
        break;
      }

      // Oldest first within the page. Display order comes from the
      // message timestamp, not from insertion order, so this changes
      // nothing in the inbox — but pages arrive newest-first, so an
      // interrupted import leaves the most recent messages in place,
      // which is the half worth having.
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

      offset = page.nextOffset;
      if (!page.hasMore) exhausted = true;
      if (messagesImported >= messageBudget) budgetSpent = true;
    }

    if (exhausted) {
      chatOffset += 1;
      chatsSeen += 1;
      messageOffset = 0;
    }

    if (budgetSpent) {
      return {
        chatsSeen,
        messagesImported,
        skippedMessages,
        failedChats,
        nextChatOffset: chatOffset,
        // Mid-thread when the chat is unfinished; the start of the next
        // chat when the budget ran out exactly as one ended.
        nextMessageOffset: exhausted ? 0 : offset,
        done: false,
      };
    }
  }

  return {
    chatsSeen,
    messagesImported,
    skippedMessages,
    failedChats,
    nextChatOffset: chatOffset,
    nextMessageOffset: 0,
    // The only way an import ends: the provider listed no more chats.
    // There is deliberately no ceiling on how far the walk goes — one
    // would silently leave an account half-imported with no way to tell.
    done: chats.length === 0,
  };
}
