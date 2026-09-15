"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import type {
  WhatsAppCapability,
  WhatsAppCapabilitySnapshot,
} from '@/lib/whatsapp/providers/types';

interface WhatsAppCapabilitiesContextValue {
  loading: boolean;
  snapshot: WhatsAppCapabilitySnapshot | null;
  supports: (capability: WhatsAppCapability) => boolean;
  refreshCapabilities: () => Promise<void>;
}

const WhatsAppCapabilitiesContext =
  createContext<WhatsAppCapabilitiesContextValue | null>(null);

export function WhatsAppCapabilitiesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id;
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<WhatsAppCapabilitySnapshot | null>(
    null
  );

  const refreshCapabilities = useCallback(async () => {
    if (!userId) {
      setSnapshot(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/whatsapp/capabilities');
      if (!response.ok) {
        setSnapshot(null);
        return;
      }
      setSnapshot((await response.json()) as WhatsAppCapabilitySnapshot);
    } catch {
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }

    void refreshCapabilities();
  }, [authLoading, refreshCapabilities]);

  const value = useMemo<WhatsAppCapabilitiesContextValue>(
    () => ({
      loading,
      snapshot,
      supports: (capability) => !loading && snapshot?.capabilities[capability] === true,
      refreshCapabilities,
    }),
    [loading, refreshCapabilities, snapshot]
  );

  return (
    <WhatsAppCapabilitiesContext.Provider value={value}>
      {children}
    </WhatsAppCapabilitiesContext.Provider>
  );
}

export function useWhatsAppCapabilities(): WhatsAppCapabilitiesContextValue {
  const context = useContext(WhatsAppCapabilitiesContext);
  if (context) return context;

  return {
    loading: true,
    snapshot: null,
    supports: () => false,
    refreshCapabilities: async () => {},
  };
}
