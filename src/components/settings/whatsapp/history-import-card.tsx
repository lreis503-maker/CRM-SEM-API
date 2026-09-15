'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import {
  deriveHistoryImportView,
  type HistoryImportProgress,
} from './history-import-state';

/**
 * Downloading the WhatsApp history into the inbox.
 *
 * The server walks the account in bounded batches so no single request
 * can time out, which means the browser has to keep asking. This card
 * owns that loop: it POSTs, shows what came back, and posts again until
 * the server says it is done or the user leaves the page. The cursor
 * lives server-side, so closing the tab costs nothing — the next click
 * carries on from the same chat.
 */

interface BatchResponse {
  done?: boolean;
  chatsSeen?: number;
  messagesImported?: number;
  failedChats?: number;
  /** Rows the provider returned that this CRM could not read. */
  unreadableChats?: number;
  skippedMessages?: number;
  error?: string;
}

/**
 * A ceiling on how many batches one click will run. The server stops at
 * its own chat limit long before this; the cap only exists so a bug
 * upstream cannot turn a click into an endless request loop.
 */
const MAX_BATCHES_PER_CLICK = 200;

export function HistoryImportCard({
  connected,
  canEdit,
}: {
  connected: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.whatsapp.uazapi.history');

  const [run, setRun] = useState<HistoryImportProgress | null>(null);
  const [working, setWorking] = useState(false);
  /**
   * Rows the provider sent that this CRM could not read, accumulated over
   * the batches of one click.
   *
   * Without this on screen, an import that understands none of the answer
   * finishes reporting "0 conversations" — indistinguishable from an
   * account that genuinely has none, which is how a broken import passes
   * for a working one.
   */
  const [unreadable, setUnreadable] = useState(0);
  // Set when the component unmounts, so an in-flight loop stops instead
  // of writing into a card that is gone.
  const stoppedRef = useRef(false);

  const loadRun = useCallback(async () => {
    try {
      const response = await fetch('/api/whatsapp/uazapi/import-history');
      if (!response.ok) return;
      const body = (await response.json()) as {
        import?: HistoryImportProgress | null;
      };
      if (!stoppedRef.current) setRun(body.import ?? null);
    } catch {
      // A failed progress read is not worth a toast: the card simply
      // shows what it last knew.
    }
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    void loadRun();
    return () => {
      stoppedRef.current = true;
    };
  }, [loadRun]);

  const view = deriveHistoryImportView({ run, working, connected, canEdit });

  async function importAll() {
    setWorking(true);
    setUnreadable(0);
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_CLICK; batch += 1) {
        if (stoppedRef.current) return;

        const response = await fetch('/api/whatsapp/uazapi/import-history', {
          method: 'POST',
        });
        const body = (await response.json().catch(() => ({}))) as BatchResponse;

        if (!response.ok) {
          toast.error(t(`errors.${body.error ?? 'unknown'}` as never));
          return;
        }

        // Progress is drawn from each reply rather than from a second
        // request, so the counters move while the walk is going.
        setRun((previous) => ({
          status: body.done === true ? 'completed' : 'running',
          chatsSeen: body.chatsSeen ?? previous?.chatsSeen ?? 0,
          messagesImported:
            body.messagesImported ?? previous?.messagesImported ?? 0,
          errorCode: null,
          startedAt: previous?.startedAt ?? new Date().toISOString(),
          finishedAt: body.done === true ? new Date().toISOString() : null,
        }));

        setUnreadable(
          (previous) =>
            previous + (body.unreadableChats ?? 0) + (body.skippedMessages ?? 0)
        );

        if (body.done === true) {
          toast.success(
            t('finished', { messages: body.messagesImported ?? 0 })
          );
          return;
        }
      }
    } catch {
      toast.error(t('errors.network'));
    } finally {
      if (!stoppedRef.current) setWorking(false);
      void loadRun();
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2 text-base">
          <Download className="text-primary size-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {view.showProgress && (
          <p
            className={`flex items-center gap-2 text-sm ${
              view.tone === 'error'
                ? 'text-red-400'
                : view.tone === 'success'
                  ? 'text-emerald-400'
                  : view.tone === 'pending'
                    ? 'text-primary'
                    : 'text-muted-foreground'
            }`}
          >
            {view.busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : view.failed ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {t('progress', {
              chats: view.chatsSeen,
              messages: view.messagesImported,
            })}
          </p>
        )}

        {view.failed && (
          <p className="text-muted-foreground text-sm">{t('failedHint')}</p>
        )}

        {unreadable > 0 && (
          <p className="text-sm text-amber-500">
            {t('unreadableHint', { count: unreadable })}
          </p>
        )}

        {view.action !== 'none' && (
          <Button onClick={() => void importAll()} disabled={view.busy}>
            <Download className="size-4" />
            {t(`action.${view.action}` as never)}
          </Button>
        )}

        {view.busy && (
          <p className="text-muted-foreground text-xs">{t('busyHint')}</p>
        )}

        <p className="text-muted-foreground text-xs">{t('note')}</p>
      </CardContent>
    </Card>
  );
}
