'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Smartphone, Wallet, Settings, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/consumer', label: 'Home', icon: Home, exact: true },
  { href: '/consumer/softphone', label: 'Softphone', icon: Smartphone },
  { href: '/consumer/wallet', label: 'Wallet', icon: Wallet },
  { href: '/consumer/assistant', label: 'Help', icon: MessageCircle },
  { href: '/consumer/settings', label: 'Settings', icon: Settings },
];

export function ConsumerBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div className="ema-shadow mx-auto flex max-w-md items-stretch justify-around gap-1 rounded-[1.75rem] border border-border/70 bg-card/75 px-2 py-1.5 backdrop-blur-xl supports-[backdrop-filter]:bg-card/60">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'ema-interactive flex flex-1 flex-col items-center gap-1 rounded-full py-2 text-[11px] font-semibold',
                active ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className={cn('size-5', active && 'fill-primary/10')} />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
