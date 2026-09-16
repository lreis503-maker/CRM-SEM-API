'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Send, Loader2, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { isMessagingWindowOpen } from '@/lib/instagram/messaging-window';
import type { InstagramConversation, InstagramMessage } from '@/types/instagram';

interface InstagramMessageThreadProps {
  conversation: InstagramConversation | null;
  messages: InstagramMessage[];
  onMessagesLoaded: (messages: InstagramMessage[]) => void;
  onNewMessage: (message: InstagramMessage) => void;
  resyncToken: number;
}

export function InstagramMessageThread({
  conversation,
  messages,
  onMessagesLoaded,
  onNewMessage,
  resyncToken,
}: InstagramMessageThreadProps) {
  const t = useTranslations('Inbox.instagram');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversation) {
      onMessagesLoaded([]);
      return;
    }
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('instagram_messages')
        .select('*')
        .eq('conversation_id', conversation!.id)
        .order('created_at', { ascending: true });
      if (!cancelled) onMessagesLoaded((data as InstagramMessage[]) ?? []);
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, resyncToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const windowOpen = isMessagingWindowOpen(conversation?.last_customer_message_at);

  const sendText = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !conversation || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/instagram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          content_type: 'text',
          content_text: trimmed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('sendError'));
        return;
      }
      onNewMessage({
        id: data.message_id,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: trimmed,
        status: 'sent',
        created_at: new Date().toISOString(),
      });
      setText('');
    } catch {
      toast.error(t('sendError'));
    } finally {
      setSending(false);
    }
  }, [text, conversation, sending, onNewMessage, t]);

  const sendFile = useCallback(
    async (file: File) => {
      if (!conversation) return;
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'document';
      const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind as keyof typeof MEDIA_MAX_BYTES_BY_KIND];
      if (file.size > maxBytes) {
        toast.error(t('fileTooLarge'));
        return;
      }
      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia('chat-media', file);
        const contentType = kind === 'document' ? 'file' : kind;
        const res = await fetch('/api/instagram/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            content_type: contentType,
            media_url: publicUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? t('sendError'));
          return;
        }
        onNewMessage({
          id: data.message_id,
          conversation_id: conversation.id,
          sender_type: 'agent',
          content_type: contentType,
          media_url: publicUrl,
          status: 'sent',
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('sendError'));
      } finally {
        setUploading(false);
      }
    },
    [conversation, onNewMessage, t],
  );

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('selectConversation')}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} t={t} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border bg-card p-3">
        {!windowOpen && (
          <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            {t('windowClosed')}
          </p>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void sendFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={!windowOpen || uploading}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t('attach')}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
            disabled={!windowOpen}
            rows={1}
            placeholder={windowOpen ? t('placeholder') : t('windowClosedPlaceholder')}
            className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            size="sm"
            disabled={!text.trim() || !windowOpen || sending}
            onClick={() => void sendText()}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  t,
}: {
  message: InstagramMessage;
  t: ReturnType<typeof useTranslations>;
}) {
  const isAgent = message.sender_type === 'agent';
  return (
    <div className={`mb-3 flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${
          isAgent ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        }`}
      >
        {message.content_type === 'text' && <p className="whitespace-pre-wrap">{message.content_text}</p>}
        {message.content_type === 'image' && message.media_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={message.media_url} alt="" className="max-h-64 rounded-lg" />
        )}
        {message.content_type === 'video' && message.media_url && (
          <video src={message.media_url} controls className="max-h-64 rounded-lg" />
        )}
        {message.content_type === 'audio' && message.media_url && <audio src={message.media_url} controls />}
        {message.content_type === 'file' && message.media_url && (
          <a href={message.media_url} target="_blank" rel="noreferrer" className="underline">
            {t('attachment')}
          </a>
        )}
        {message.content_type === 'story_mention' && <p>{t('storyMention')}</p>}
        {message.content_type === 'share' && <p>{t('sharedPost')}</p>}
        {message.content_type === 'unsupported' && <p>{t('unsupported')}</p>}
      </div>
    </div>
  );
}
