'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { InstagramConversation } from '@/types/instagram';

interface InstagramConversationListProps {
  conversations: InstagramConversation[];
  activeConversationId: string | null;
  onSelect: (conv: InstagramConversation) => void;
  onConversationsLoaded: (conversations: InstagramConversation[]) => void;
  resyncToken: number;
}

export function InstagramConversationList({
  conversations,
  activeConversationId,
  onSelect,
  onConversationsLoaded,
  resyncToken,
}: InstagramConversationListProps) {
  const t = useTranslations('Inbox.instagram');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('instagram_conversations')
        .select('*, contact:instagram_contacts(*)')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (!cancelled) {
        onConversationsLoaded((data as InstagramConversation[]) ?? []);
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resyncToken]);

  if (loading) {
    return (
      <div className="w-full max-w-sm border-r border-border p-4 text-sm text-muted-foreground">
        {t('loading')}
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col overflow-y-auto border-r border-border">
      {conversations.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">{t('emptyList')}</p>
      )}
      {conversations.map((conv) => {
        const label = conv.contact?.name || conv.contact?.username || t('noContactName');
        return (
          <button
            key={conv.id}
            type="button"
            onClick={() => onSelect(conv)}
            className={cn(
              'flex items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/40',
              activeConversationId === conv.id && 'bg-muted/60',
            )}
          >
            {conv.contact?.profile_pic_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={conv.contact.profile_pic_url}
                alt={label}
                className="h-10 w-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {label.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">{label}</span>
                {conv.unread_count > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {conv.unread_count}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {conv.last_message_text || t('noMessages')}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
