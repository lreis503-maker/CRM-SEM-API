'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plus, Tag as TagIcon, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAuth } from '@/hooks/use-auth';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { deriveTagPickerView, nextTagColor } from '@/lib/contacts/tag-picker';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types';

/**
 * Categorising a lead without leaving the conversation.
 *
 * Tagging used to mean opening Contacts, finding the person and editing
 * them — so in practice, while a seller was mid-conversation, it did not
 * happen. The tags are right where the decision is made.
 *
 * Writes go through /api/contacts/[id]/tags rather than straight to the
 * table, because adding a tag is also an automation trigger (`tag_added`)
 * and that dispatch lives behind the route.
 */

interface ContactTagPickerProps {
  contactId: string;
  /** Tags currently on the contact. */
  value: Tag[];
  /** Called after a change lands, so the sidebar can refresh. */
  onChange: (tags: Tag[]) => void;
  disabled?: boolean;
}

export function ContactTagPicker({
  contactId,
  value,
  onChange,
  disabled = false,
}: ContactTagPickerProps) {
  const t = useTranslations('Inbox.sidebar');
  const { accountId, user } = useAuth();
  const supabase = createClient();

  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [search, setSearch] = useState('');
  const [busyTagId, setBusyTagId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*').order('name');
    if (data) setAllTags(data as Tag[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) void loadTags();
  }, [open, loadTags]);

  const view = deriveTagPickerView({
    allTags,
    selectedIds: value.map((tag) => tag.id),
    search,
  });

  async function toggle(tag: Tag) {
    if (busyTagId !== null) return;
    setBusyTagId(tag.id);

    const wasOn = value.some((t) => t.id === tag.id);
    try {
      if (wasOn) {
        await deleteContactTag(contactId, tag.id);
        onChange(value.filter((t) => t.id !== tag.id));
      } else {
        await addContactTag(contactId, tag.id);
        onChange([...value, tag]);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('tagUpdateFailed')
      );
    } finally {
      setBusyTagId(null);
    }
  }

  async function createAndApply(name: string) {
    if (!accountId || !user) {
      toast.error(t('tagUpdateFailed'));
      return;
    }
    setCreating(true);

    try {
      // account_id is mandatory on every account-scoped insert (NOT NULL
      // + RLS, no DB default) — same as the tag manager in Settings.
      const { data, error } = await supabase
        .from('tags')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name,
          color: nextTagColor(allTags),
        })
        .select('*')
        .single();

      if (error || !data) throw error ?? new Error('insert failed');

      const created = data as Tag;
      setAllTags((prev) => [...prev, created]);
      setSearch('');

      // Created and applied in one action: someone who typed a name into
      // a contact's tag box wants it on that contact, not merely to exist.
      await addContactTag(contactId, created.id);
      onChange([...value, created]);
    } catch {
      toast.error(t('tagCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {value.map((tag) => (
        <span
          key={tag.id}
          className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
        >
          {tag.name}
          {!disabled && (
            <button
              type="button"
              onClick={() => void toggle(tag)}
              disabled={busyTagId !== null}
              aria-label={t('tagRemove', { name: tag.name })}
              className="opacity-50 transition-opacity hover:opacity-100 disabled:opacity-30"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}

      {value.length === 0 && (
        <span className="text-muted-foreground px-1 text-xs">
          {t('noTags')}
        </span>
      )}

      {!disabled && (
        <Popover open={open} onOpenChange={setOpen}>
          {/* Trigger styled directly rather than wrapping a Button:
              this project's Button has no asChild, and the rest of the
              inbox uses PopoverTrigger the same way. */}
          <PopoverTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[10px] transition-colors">
            <Plus className="h-3 w-3" />
            {t('tagAdd')}
          </PopoverTrigger>

          <PopoverContent align="start" className="w-64 p-2">
            <Input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('tagSearchPlaceholder')}
              className="h-8 text-xs"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && view.creatableName) {
                  event.preventDefault();
                  void createAndApply(view.creatableName);
                }
              }}
            />

            <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
              {view.options.map(({ tag, selected }) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => void toggle(tag)}
                  disabled={busyTagId !== null}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                    'hover:bg-muted disabled:opacity-50'
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1 truncate">{tag.name}</span>
                  {busyTagId === tag.id ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  ) : (
                    selected && <Check className="h-3 w-3 shrink-0" />
                  )}
                </button>
              ))}

              {view.noTagsYet && (
                <p className="text-muted-foreground px-2 py-3 text-center text-xs">
                  {t('tagNoneYet')}
                </p>
              )}

              {view.emptyBecauseOfSearch && !view.creatableName && (
                <p className="text-muted-foreground px-2 py-3 text-center text-xs">
                  {t('tagNoMatch')}
                </p>
              )}
            </div>

            {view.creatableName && (
              <button
                type="button"
                onClick={() => void createAndApply(view.creatableName!)}
                disabled={creating}
                className="border-border hover:bg-muted mt-1 flex w-full items-center gap-2 rounded border-t px-2 py-2 text-left text-xs transition-colors disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : (
                  <TagIcon className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">
                  {t('tagCreate', { name: view.creatableName })}
                </span>
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
