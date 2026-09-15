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

/**
 * How many samples of unreadable rows one batch reports. Three is enough
 * to see the shape and to notice if two different shapes are arriving;
 * more would just fill the diagnostics table with copies.
 */
const MAX_UNREADABLE_SAMPLES = 3;

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
  /**
   * Called with a redacted-later sample of a row the client could not
   * read, so the shape actually being returned can be inspected instead
   * of guessed at. Called a handful of times per batch at most — a few
   * samples say everything a thousand identical ones would.
   *
   * Never allowed to fail the import: diagnostics that break the thing
   * they diagnose are worse than none.
   */
  onUnreadable?(input: {
    kind: 'chat' | 'message' | 'chat_list';
    sample: unknown;
  }): Promise<void>;
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
  /**
   * Rows the chat listing returned that carried no usable id.
   *
   * Any number above zero means the provider is answering in a shape
   * this CRM does not understand, and the import is walking less of the
   * account than it thinks.
   */
  unreadableChats: number;
  /**
   * True when the provider's answer carried no list at all — a shape
   * this CRM does not understand. Distinct from an empty list, which
   * simply means the account has no more conversations.
   */
  unreadableChatList: boolean;
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

  const { chats, unreadable, noListFound, bodySample } =
    await input.client.findChats({
      limit: chatsPerBatch,
      offset: input.chatOffset,
    });

  let chatsSeen = 0;
  let messagesImported = 0;
  let skippedMessages = 0;
  let failedChats = 0;
  let samplesReported = 0;

  async function reportUnreadable(
    kind: 'chat' | 'message' | 'chat_list',
    sample: unknown
  ) {
    if (!input.onUnreadable || samplesReported >= MAX_UNREADABLE_SAMPLES) {
      return;
    }
    samplesReported += 1;
    try {
      await input.onUnreadable({ kind, sample });
    } catch {
      // Recording a diagnostic must never be what stops an import.
    }
  }

  // The body held no list anywhere. That is not an empty account — it
  // is an answer in a shape this CRM cannot read, and the sample is the
  // only way to find out which shape.
  if (noListFound) {
    await reportUnreadable('chat_list', bodySample);
  }

  for (const row of unreadable) {
    await reportUnreadable('chat', row);
  }

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
          // an import over. An unreadable one is worth a sample, though —
          // a thread that imports nothing looks the same as a thread with
          // nothing in it.
          if (result.outcome === 'quarantine') {
            skippedMessages += 1;
            await reportUnreadable('message', record);
          }
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
        unreadableChats: unreadable.length,
        unreadableChatList: noListFound,
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
    unreadableChats: unreadable.length,
    unreadableChatList: noListFound,
    nextChatOffset: chatOffset,
    nextMessageOffset: 0,
    // The only way an import ends: the provider returned a list, and it
    // was empty. A body with no list in it, or one whose rows we could
    // not read, is never mistaken for the end — those two silences are
    // exactly what made a truncated import look finished.
    done: chats.length === 0 && unreadable.length === 0 && !noListFound,
  };
}
