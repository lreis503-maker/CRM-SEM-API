'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { InstagramMessage, InstagramConversation } from '@/types/instagram';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  old: Partial<T>;
}

interface UseInstagramRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<InstagramMessage>) => void;
  onConversationEvent?: (event: RealtimeEvent<InstagramConversation>) => void;
  enabled?: boolean;
}

export function useInstagramRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseInstagramRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'instagram_messages' },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<InstagramMessage>['eventType'],
            new: payload.new as InstagramMessage,
            old: payload.old as Partial<InstagramMessage>,
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'instagram_conversations' },
        (payload) => {
          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<InstagramConversation>['eventType'],
            new: payload.new as InstagramConversation,
            old: payload.old as Partial<InstagramConversation>,
          });
        },
      )
      .subscribe((status) => setIsConnected(status === 'SUBSCRIBED'));

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
