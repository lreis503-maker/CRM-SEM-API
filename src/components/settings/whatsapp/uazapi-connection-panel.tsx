'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  QrCode,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useWhatsAppCapabilities } from '@/hooks/use-whatsapp-capabilities';
import type { WhatsAppProvider } from '@/lib/whatsapp/providers/types';

import { HistoryImportCard } from './history-import-card';
import {
  deriveUazapiViewState,
  type UazapiPrimaryAction,
} from './uazapi-view-state';

/** Matches the server's public connection view. No credentials. */
interface UazapiConnectionView {
  provider: 'uazapi';
  status:
    | 'not_configured'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'hibernated'
    | 'error';
  attemptId: string;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  connectedAvatarUrl: string | null;
  error: string | null;
}

interface ProviderSwitchCounts {
  cancelledBroadcasts: number;
  deactivatedAutomations: number;
  draftedFlows: number;
  stoppedFlowRuns: number;
}

interface UazapiConnectionPanelProps {
  /** The provider saved for the account right now. */
  activeProvider: WhatsAppProvider;
  uazapiAvailable: boolean;
  canEdit: boolean;
  /** Called after the saved provider changes, so the parent can reload. */
  onProviderChanged: () => void;
}

const POLL_INTERVAL_MS = 3000;
const NOT_CONFIGURED: UazapiConnectionView = {
  provider: 'uazapi',
  status: 'not_configured',
  attemptId: '',
  qrCodeDataUrl: null,
  qrExpiresAt: null,
  connectedPhone: null,
  connectedName: null,
  connectedAvatarUrl: null,
  error: null,
};

export function UazapiConnectionPanel({
  activeProvider,
  uazapiAvailable,
  canEdit,
  onProviderChanged,
}: UazapiConnectionPanelProps) {
  const t = useTranslations('Settings.whatsapp.uazapi');
  const { refreshCapabilities } = useWhatsAppCapabilities();

  const [connection, setConnection] = useState<UazapiConnectionView | null>(
    activeProvider === 'uazapi' ? null : NOT_CONFIGURED
  );
  const [loading, setLoading] = useState(activeProvider === 'uazapi');
  const [busy, setBusy] = useState(false);
  const [affected, setAffected] = useState<ProviderSwitchCounts | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // One controller for the in-flight status poll, so navigating away or
  // hiding the tab does not leave a request writing into a dead component.
  const pollAbortRef = useRef<AbortController | null>(null);
  const lastPollRef = useRef(0);

  const state = deriveUazapiViewState(
    connection ?? NOT_CONFIGURED,
    new Date(nowMs)
  );

  const loadStatus = useCallback(async () => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    try {
      const attempt = connection?.attemptId;
      const query = attempt ? `?attempt=${encodeURIComponent(attempt)}` : '';
      const response = await fetch(`/api/whatsapp/uazapi/status${query}`, {
        signal: controller.signal,
      });

      if (response.status === 404) {
        setConnection(NOT_CONFIGURED);
        return;
      }
      if (!response.ok) return;

      const body = (await response.json()) as {
        connection: UazapiConnectionView;
      };
      setConnection(body.connection);
    } catch {
      // An aborted or failed poll is not worth a toast; the next tick
      // retries and a real failure surfaces as the row's own error state.
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
    }
  }, [connection?.attemptId]);

  // Resume on mount: a reload during pairing picks the same attempt back up.
  useEffect(() => {
    if (activeProvider !== 'uazapi') {
      setConnection(NOT_CONFIGURED);
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      await loadStatus();
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally runs once per provider change: loadStatus changes
    // identity with every attempt id, which would re-trigger the resume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider]);

  useEffect(() => () => pollAbortRef.current?.abort(), []);

  // A single one-second tick drives both the countdown and the poll. It
  // only runs while a live QR is on screen, so an idle panel is silent.
  useEffect(() => {
    if (!state.poll) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.poll]);

  useEffect(() => {
    if (!state.poll) return;
    if (typeof document !== 'undefined' && document.hidden) {
      pollAbortRef.current?.abort();
      return;
    }
    if (nowMs - lastPollRef.current < POLL_INTERVAL_MS) return;

    lastPollRef.current = nowMs;
    void loadStatus();
  }, [state.poll, nowMs, loadStatus]);

  async function runConnect(action: 'start' | 'refresh_qr') {
    setBusy(true);
    try {
      const response = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as {
        connection?: UazapiConnectionView;
        affected?: ProviderSwitchCounts | null;
        error?: string;
      };

      if (!response.ok || !body.connection) {
        toast.error(t(`errors.${body.error ?? 'unknown'}` as never));
        return;
      }

      setConnection(body.connection);
      setAffected(body.affected ?? null);
      lastPollRef.current = Date.now();
      setNowMs(Date.now());
      await refreshCapabilities();
      if (action === 'start') onProviderChanged();
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      const response = await fetch('/api/whatsapp/config', {
        method: 'DELETE',
      });
      if (!response.ok) {
        toast.error(t('removeFailed'));
        return;
      }
      setConnection(NOT_CONFIGURED);
      setAffected(null);
      toast.success(t('removed'));
      await refreshCapabilities();
      onProviderChanged();
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  function handlePrimary(action: UazapiPrimaryAction) {
    if (action === 'none') return;
    // Starting is the destructive step: it replaces the active Meta
    // connection. Everything else acts on an instance the account owns.
    if (action === 'start') {
      setConfirmOpen(true);
      return;
    }
    void runConnect('refresh_qr');
  }

  if (!uazapiAvailable) {
    return (
      <Alert className="border-amber-600/40 bg-amber-950/30">
        <AlertTriangle className="size-5 text-amber-400" />
        <AlertTitle className="text-amber-200">
          {t('unavailableTitle')}
        </AlertTitle>
        <AlertDescription className="text-sm text-amber-100/80">
          {t('unavailableBody')}
        </AlertDescription>
      </Alert>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const primaryLabel: Record<UazapiPrimaryAction, string> = {
    start: t('startButton'),
    refresh_qr: t('refreshQrButton'),
    reconnect: t('reconnectButton'),
    retry: t('retryButton'),
    none: '',
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground flex items-center gap-2">
              <QrCode className="text-primary size-5" />
              {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <StatusLine
              status={state.tone}
              label={t(
                `status.${connection?.status ?? 'not_configured'}` as never
              )}
            />

            {connection?.status === 'connected' && (
              <div className="text-muted-foreground space-y-1 text-sm">
                {connection.connectedName && (
                  <p>
                    {t('connectedName')}:{' '}
                    <strong className="text-foreground">
                      {connection.connectedName}
                    </strong>
                  </p>
                )}
                {connection.connectedPhone && (
                  <p>
                    {t('connectedPhone')}:{' '}
                    <strong className="text-foreground">
                      {connection.connectedPhone}
                    </strong>
                  </p>
                )}
              </div>
            )}

            {state.showQr && connection?.qrCodeDataUrl && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">{t('scanHint')}</p>
                {/* Fixed box on a white ground: a QR needs quiet margins
                    and real contrast to scan from a phone camera. */}
                <div className="w-fit rounded-lg bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={connection.qrCodeDataUrl}
                    alt={t('qrAlt')}
                    width={256}
                    height={256}
                    className="block size-[256px] max-w-full"
                  />
                </div>
                {state.secondsLeft !== null && (
                  <p className="text-muted-foreground text-xs">
                    {t('expiresIn', { seconds: state.secondsLeft })}
                  </p>
                )}
              </div>
            )}

            {state.qrExpired && (
              <Alert className="border-amber-600/40 bg-amber-950/30">
                <AlertTitle className="text-amber-200">
                  {t('qrExpiredTitle')}
                </AlertTitle>
                <AlertDescription className="text-sm text-amber-100/80">
                  {t('qrExpiredBody')}
                </AlertDescription>
              </Alert>
            )}

            {connection?.status === 'error' && (
              <Alert className="border-red-700/50 bg-red-950/30">
                <AlertTitle className="text-red-200">
                  {t('errorTitle')}
                </AlertTitle>
                <AlertDescription className="text-sm text-red-100/80">
                  {t('errorBody')}
                </AlertDescription>
              </Alert>
            )}

            {affected && (
              <Alert className="border-border bg-muted/30">
                <AlertTitle>{t('switchedTitle')}</AlertTitle>
                <AlertDescription className="text-muted-foreground text-sm">
                  {t('switchedBody', {
                    broadcasts: affected.cancelledBroadcasts,
                    automations: affected.deactivatedAutomations,
                    flows: affected.draftedFlows,
                  })}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              {state.primaryAction !== 'none' && (
                <Button
                  onClick={() => handlePrimary(state.primaryAction)}
                  disabled={!canEdit || busy}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  {primaryLabel[state.primaryAction]}
                </Button>
              )}

              {state.canRemove && (
                <Button
                  variant="outline"
                  onClick={() => void handleRemove()}
                  disabled={!canEdit || busy}
                >
                  <Trash2 className="size-4" />
                  {t('removeButton')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        {/* Only meaningful once a number is paired: before that there is
            no instance whose history could be read. */}
        <HistoryImportCard
          connected={connection?.status === 'connected'}
          canEdit={canEdit}
        />

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground text-base">
              {t('howToTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-sm">
              <li>{t('howToStep1')}</li>
              <li>{t('howToStep2')}</li>
              <li>{t('howToStep3')}</li>
            </ol>
            <p className="text-muted-foreground mt-4 text-xs">
              {t('limitsNote')}
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{t('confirmBody')}</DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">{t('confirmHistory')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('confirmCancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                void runConnect('start');
              }}
            >
              {t('confirmAccept')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusLine({
  status,
  label,
}: {
  status: 'idle' | 'pending' | 'success' | 'warning' | 'error';
  label: string;
}) {
  const tone = {
    idle: 'text-muted-foreground',
    pending: 'text-primary',
    success: 'text-emerald-400',
    warning: 'text-amber-400',
    error: 'text-red-400',
  }[status];

  return (
    <p className={`flex items-center gap-2 text-sm font-medium ${tone}`}>
      {status === 'success' ? (
        <CheckCircle2 className="size-4" />
      ) : status === 'pending' ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <AlertTriangle className="size-4" />
      )}
      {label}
    </p>
  );
}
