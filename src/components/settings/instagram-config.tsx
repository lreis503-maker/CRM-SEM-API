'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';

interface ConfigResponse {
  connected: boolean;
  config?: {
    page_id: string;
    ig_user_id: string;
    ig_username: string | null;
    status: string;
    connected_at: string | null;
  };
}

export function InstagramConfigPanel() {
  const t = useTranslations('Settings.instagram');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pageId, setPageId] = useState('');
  const [igUserId, setIgUserId] = useState('');
  const [igUsername, setIgUsername] = useState('');
  const [pageAccessToken, setPageAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/instagram/config');
      const data: ConfigResponse = await res.json();
      setConnected(data.connected);
      if (data.config) {
        setPageId(data.config.page_id);
        setIgUserId(data.config.ig_user_id);
        setIgUsername(data.config.ig_username ?? '');
      }
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (!pageId.trim() || !igUserId.trim() || !pageAccessToken.trim()) {
      toast.error(t('requiredFields'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId.trim(),
          ig_user_id: igUserId.trim(),
          ig_username: igUsername.trim() || undefined,
          page_access_token: pageAccessToken.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveError'));
        return;
      }
      setVerifyToken(data.verify_token);
      setPageAccessToken('');
      setConnected(true);
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(false);
    }
  }, [pageId, igUserId, igUsername, pageAccessToken, t]);

  const handleDisconnect = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('disconnectError'));
        return;
      }
      setConnected(false);
      setPageId('');
      setIgUserId('');
      setIgUsername('');
      setVerifyToken(null);
      toast.success(t('disconnectSuccess'));
    } catch {
      toast.error(t('disconnectError'));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/instagram/webhook` : '';

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="space-y-4">
        <div
          className={
            connected
              ? 'rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400'
              : 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400'
          }
        >
          {connected ? t('statusConnected') : t('statusDisconnected')}
        </div>

        <Field label={t('pageId')}>
          <input
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="17841400000000000"
          />
        </Field>

        <Field label={t('igUserId')}>
          <input
            value={igUserId}
            onChange={(e) => setIgUserId(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="17841400000000000"
          />
        </Field>

        <Field label={t('igUsername')}>
          <input
            value={igUsername}
            onChange={(e) => setIgUsername(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="minhaempresa"
          />
        </Field>

        <Field label={t('pageAccessToken')}>
          <input
            type="password"
            value={pageAccessToken}
            onChange={(e) => setPageAccessToken(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder={connected ? t('tokenPlaceholderConnected') : ''}
          />
        </Field>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {t('save')}
          </Button>
          {connected && (
            <Button variant="outline" onClick={handleDisconnect} disabled={saving}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t('disconnect')}
            </Button>
          )}
        </div>

        {verifyToken && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">{t('webhookSetupTitle')}</p>
            <p className="mt-1">{t('webhookUrlLabel')}</p>
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1">{webhookUrl}</code>
            <p className="mt-2">{t('verifyTokenLabel')}</p>
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1">{verifyToken}</code>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
