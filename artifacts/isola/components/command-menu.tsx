'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutGrid,
  Inbox,
  Bot,
  Phone,
  Wallet,
  BarChart3,
  Building2,
  Sun,
  Moon,
  Activity,
  ListChecks,
  Users,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { usePreferencesStore } from '@/stores/preferences/preferences-provider';

interface CommandMenuProps {
  isAdmin: boolean;
  showOwnerNav: boolean;
}

const OWNER_PAGES = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
  { href: '/workspace', label: 'Workspace', icon: ListChecks },
  { href: '/team', label: 'AI Team', icon: Users },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/activity', label: 'Activity & Reports', icon: Activity },
  { href: '/agent', label: 'AI Agent', icon: Bot },
  { href: '/voice', label: 'Voice', icon: Phone },
  { href: '/wallet', label: 'Wallet', icon: Wallet },
  { href: '/plan', label: 'Plan & Usage', icon: BarChart3 },
];

const ADMIN_PAGES = [{ href: '/admin', label: 'Tenants', icon: Building2 }];

export function CommandMenu({ isAdmin, showOwnerNav }: CommandMenuProps) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const setPreference = usePreferencesStore(useShallow((s) => s.setPreference));

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  const pages = showOwnerNav ? OWNER_PAGES : ADMIN_PAGES;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {pages.map((p) => (
            <CommandItem key={p.href} onSelect={() => go(p.href)}>
              <p.icon />
              <span>{p.label}</span>
            </CommandItem>
          ))}
          {isAdmin && !showOwnerNav && null}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Theme">
          <CommandItem onSelect={() => { setPreference('theme_mode', 'light'); setOpen(false); }}>
            <Sun /> <span>Light</span>
          </CommandItem>
          <CommandItem onSelect={() => { setPreference('theme_mode', 'dark'); setOpen(false); }}>
            <Moon /> <span>Dark</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
