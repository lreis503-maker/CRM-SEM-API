'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useWhatsAppCapabilities } from '@/hooks/use-whatsapp-capabilities';
import type { WhatsAppProvider } from '@/lib/whatsapp/providers/types';

import { SettingsPanelHead } from './settings-panel-head';
import { MetaConnectionPanel } from './whatsapp/meta-connection-panel';
import { ProviderSelector } from './whatsapp/provider-selector';
import { UazapiConnectionPanel } from './whatsapp/uazapi-connection-panel';

/**
 * The WhatsApp settings panel.
 *
 * This file used to be the Meta form itself. It is now the shell: it owns
 * the heading and the provider choice, and renders exactly one connection
 * panel. The Meta form moved to `whatsapp/meta-connection-panel.tsx`
 * unchanged, so nothing about the existing Meta flow shifted.
 *
 * The account's active provider comes from the capability snapshot, which
 * the dashboard already loads — so this panel agrees with the sidebar and
 * the rest of Settings about which provider is in use.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const { canEditSettings, loading: authLoading, profileLoading } = useAuth();
  const {
    snapshot,
    loading: capabilitiesLoading,
    refreshCapabilities,
  } = useWhatsAppCapabilities();

  const activeProvider: WhatsAppProvider = snapshot?.provider ?? 'meta';

  // Only the deliberate "show me the other provider" choice is state.
  // Everything else follows the saved provider, so a switch completing —
  // here or in another tab — moves the panel without an extra effect.
  const [previewing, setPreviewing] = useState<WhatsAppProvider | null>(null);
  const selected = previewing ?? activeProvider;

  const handleProviderChanged = useCallback(() => {
    setPreviewing(null);
    void refreshCapabilities();
  }, [refreshCapabilities]);

  const loading = authLoading || profileLoading || capabilitiesLoading;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : (
        <>
          <ProviderSelector
            active={activeProvider}
            selected={selected}
            onSelect={(provider) =>
              setPreviewing(provider === activeProvider ? null : provider)
            }
            uazapiAvailable={snapshot?.uazapiAvailable === true}
            canEdit={canEditSettings}
          />

          {selected === 'uazapi' ? (
            <UazapiConnectionPanel
              activeProvider={activeProvider}
              uazapiAvailable={snapshot?.uazapiAvailable === true}
              canEdit={canEditSettings}
              onProviderChanged={handleProviderChanged}
            />
          ) : (
            <MetaConnectionPanel />
          )}
        </>
      )}
    </section>
  );
}
