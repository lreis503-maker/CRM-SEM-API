import Image from 'next/image';
import { cn } from '@/lib/utils';

interface BrandLogoProps {
  size?: 'sm' | 'lg';
  showName?: boolean;
  className?: string;
}

export function BrandLogo({
  size = 'sm',
  showName = true,
  className,
}: BrandLogoProps) {
  const large = size === 'lg';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2.5',
        large && 'flex-col gap-2',
        className
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-xl bg-[#fff3e4] ring-1 ring-[#9c5227]/15',
          large ? 'h-16 w-16 p-1.5' : 'h-9 w-9 p-1'
        )}
      >
        <Image
          src="/brand/vortex-symbol.png"
          alt={showName ? '' : 'Vortex CRM'}
          width={large ? 52 : 28}
          height={large ? 52 : 28}
          className="h-full w-full object-contain"
          unoptimized
        />
      </span>
      {showName && (
        <span
          className={cn(
            'text-foreground font-semibold whitespace-nowrap',
            large ? 'text-base' : 'text-sm'
          )}
        >
          Vortex CRM
        </span>
      )}
    </span>
  );
}
