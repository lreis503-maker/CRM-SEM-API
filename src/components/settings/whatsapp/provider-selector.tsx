'use client';

import { Check, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { WhatsAppProvider } from '@/lib/whatsapp/providers/types';
import { cn } from '@/lib/utils';

interface ProviderSelectorProps {
  /** The provider currently saved for the account. */
  active: WhatsAppProvider;
  /** The provider the user is looking at, which may differ from `active`. */
  selected: WhatsAppProvider;
  onSelect: (provider: WhatsAppProvider) => void;
  /** False when the installation has no usable UAZAPI configuration. */
  uazapiAvailable: boolean;
  /** False for members who may not change connection settings. */
  canEdit: boolean;
}

/**
 * A two-option segmented control. Selecting the inactive provider only
 * changes what is on screen — nothing is switched until the user confirms
 * inside the panel, because switching is destructive to the current
 * connection.
 */
export function ProviderSelector({
  active,
  selected,
  onSelect,
  uazapiAvailable,
  canEdit,
}: ProviderSelectorProps) {
  const t = useTranslations('Settings.whatsapp.providerChoice');

  const options: Array<{
    value: WhatsAppProvider;
    label: string;
    hint: string;
    disabled: boolean;
    disabledReason: string | null;
  }> = [
    {
      value: 'meta',
      label: t('metaLabel'),
      hint: t('metaHint'),
      disabled: !canEdit,
      disabledReason: canEdit ? null : t('needsAdmin'),
    },
    {
      value: 'uazapi',
      label: t('uazapiLabel'),
      hint: t('uazapiHint'),
      disabled: !canEdit || !uazapiAvailable,
      disabledReason: !canEdit
        ? t('needsAdmin')
        : uazapiAvailable
          ? null
          : t('uazapiUnavailable'),
    },
  ];

  return (
    <div className="mb-6">
      <p className="text-foreground mb-2 text-sm font-medium">{t('label')}</p>
      {/* Wraps below ~400px so neither card is squeezed on a phone. */}
      <div
        role="radiogroup"
        aria-label={t('label')}
        className="flex flex-wrap gap-2"
      >
        {options.map((option) => {
          const isSelected = selected === option.value;
          const isActive = active === option.value;

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-disabled={option.disabled}
              title={option.disabledReason ?? undefined}
              onClick={() => {
                if (option.disabled) return;
                onSelect(option.value);
              }}
              className={cn(
                'min-w-[200px] flex-1 rounded-lg border px-4 py-3 text-left transition-colors',
                isSelected
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/40',
                option.disabled && 'cursor-not-allowed opacity-50'
              )}
            >
              <span className="text-foreground flex items-center gap-2 text-sm font-medium">
                {option.label}
                {isActive && (
                  <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-normal">
                    <Check className="size-3" />
                    {t('activeBadge')}
                  </span>
                )}
                {option.disabled && option.disabledReason && (
                  <Lock className="text-muted-foreground size-3" />
                )}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {option.disabledReason ?? option.hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
