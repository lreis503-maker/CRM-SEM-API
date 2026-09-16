'use client';

import { useCallback, useState } from 'react';
import { InstagramConversationList } from '@/components/inbox/instagram/instagram-conversation-list';
import { InstagramMessageThread } from '@/components/inbox/instagram/instagram-message-thread';
import { useInstagramRealtime } from '@/hooks/use-instagram-realtime';
import type { InstagramConversation, InstagramMessage } from '@/types/instagram';

export function InstagramInboxPage() {
  const [conversations, setConversations] = useState<InstagramConversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<InstagramConversation | null>(null);
  const [messages, setMessages] = useState<InstagramMessage[]>([]);
  const [resyncToken, setResyncToken] = useState(0);

  const handleSelect = useCallback((conv: InstagramConversation) => {
    setActiveConversation(conv);
    setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c)));
  }, []);

  useInstagramRealtime({
    channelName: 'instagram-inbox-realtime',
    enabled: true,
    onMessageEvent: (event) => {
      if (event.eventType !== 'INSERT') return;
      const msg = event.new;
      setMessages((prev) => {
        if (!activeConversation || msg.conversation_id !== activeConversation.id) return prev;
        return prev.some((m) => m.id === msg.id) ? prev : [...prev, msg];
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === msg.conversation_id
            ? {
                ...c,
                last_message_text: msg.content_text ?? '',
                last_message_at: msg.created_at,
                unread_count: activeConversation?.id === msg.conversation_id ? 0 : c.unread_count + 1,
              }
            : c,
        ),
      );
    },
    onConversationEvent: (event) => {
      if (event.eventType !== 'INSERT') return;
      setConversations((prev) =>
        prev.some((c) => c.id === event.new.id) ? prev : [...prev, event.new],
      );
    },
  });

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <InstagramConversationList
        conversations={conversations}
        activeConversationId={activeConversation?.id ?? null}
        onSelect={handleSelect}
        onConversationsLoaded={setConversations}
        resyncToken={resyncToken}
      />
      <InstagramMessageThread
        conversation={activeConversation}
        messages={messages}
        onMessagesLoaded={setMessages}
        onNewMessage={(msg) => setMessages((prev) => [...prev, msg])}
        resyncToken={resyncToken}
      />
    </div>
  );
}
