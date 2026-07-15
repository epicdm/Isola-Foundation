'use client';

import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { LayoutControls } from '@/components/layout-controls';
import { CommandMenu } from '@/components/command-menu';
import { cn } from '@/lib/utils';

interface TopbarProps {
  isAdmin: boolean;
  showOwnerNav: boolean;
}

const TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/inbox': 'Inbox',
  '/agent': 'AI Agent',
  '/voice': 'Voice',
  '/wallet': 'Wallet',
  '/plan': 'Plan & Usage',
  '/admin': 'Tenants',
  '/onboard': 'Connect WhatsApp',
};

function titleFor(pathname: string) {
  if (TITLES[pathname]) return TITLES[pathname];
  const match = Object.keys(TITLES).find((k) => pathname.startsWith(k));
  return match ? TITLES[match] : 'Isola';
}

/** Ported from Studio Admin's dashboard header — sticky/scroll navbar style, search, layout + theme controls. */
export function Topbar({ isAdmin, showOwnerNav }: TopbarProps) {
  const pathname = usePathname();

  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear',
        '[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:bg-background/80 [html[data-navbar-style=sticky]_&]:backdrop-blur-md',
      )}
    >
      <div className="flex w-full items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-1 lg:gap-2">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
          <h1 className="text-sm font-semibold">{titleFor(pathname)}</h1>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="hidden h-8 gap-2 text-muted-foreground sm:flex"
            onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
          >
            <Search className="size-3.5" />
            <span>Search…</span>
            <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium">&#8984;K</kbd>
          </Button>
          <LayoutControls />
          <ThemeSwitcher />
        </div>
      </div>
      <CommandMenu isAdmin={isAdmin} showOwnerNav={showOwnerNav} />
    </header>
  );
}
