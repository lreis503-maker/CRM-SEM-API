"use client";

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { useWhatsAppCapabilities } from '@/hooks/use-whatsapp-capabilities';
import type { WhatsAppCapability } from '@/lib/whatsapp/providers/types';

export function ProviderPageGuard({
  capability,
  children,
}: {
  capability: WhatsAppCapability;
  children: ReactNode;
}) {
  const router = useRouter();
  const { snapshot, supports } = useWhatsAppCapabilities();
  const allowed = supports(capability);

  useEffect(() => {
    if (snapshot?.provider === 'uazapi' && !allowed) {
      router.replace('/settings?tab=whatsapp&reason=provider_not_supported');
    }
  }, [allowed, router, snapshot?.provider]);

  if (!allowed) return null;

  return <>{children}</>;
}
