'use client';

// PreviewSidebar — a preview-only sibling of components/app-sidebar.tsx.
//
// Why this exists instead of reusing AppSidebar directly: AppSidebar hardcodes
// its own OWNER_NAV/ADMIN_NAV constants (pointing at the real, DB-backed
// /dashboard, /inbox, /agent, /voice, /wallet, /plan routes) with no prop to
// override them, and this preview needs its own nav pointing at /preview/*.
// Rather than editing the shared component that the real, live app depends on,
// this file copies its header/footer chrome (logo block, tenant name, avatar
// menu) and renders the reusable `NavMain` component — which *does* take a
// `groups` prop — with this preview's own nav groups. Visually identical,
// wired differently.
import Link from 'next/link';
import {
  Activity,
  Bot,
  Building2,
  ChevronsUpDown,
  Command,
  Eye,
  Home,
  Inbox,
  LifeBuoy,
  Phone,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NavMain, type NavGroup } from '@/components/nav-main';

// Nav groups live here — inside the client component — rather than being built
// in the (server) layout and passed down as props. lucide-react icon components
// are function references; React cannot serialize them across the Server-to-
// Client Component boundary ("Only plain objects can be passed..."), so they
// have to be constructed on the client side, same as the real AppSidebar does
// with its own OWNER_NAV/ADMIN_NAV constants.
const CONTROL_PLANE_NAV: NavGroup = {
  label: 'Control plane (preview)',
  items: [
    { href: '/preview/control-plane/home', label: 'Home', icon: Home },
    { href: '/preview/control-plane/ai-team', label: 'AI Team', icon: Bot },
    { href: '/preview/control-plane/channels', label: 'Channels', icon: Phone },
    { href: '/preview/control-plane/integrations', label: 'Integrations', icon: Plug },
    { href: '/preview/control-plane/conversations', label: 'Conversations', icon: Inbox },
    { href: '/preview/control-plane/billing', label: 'Billing', icon: Wallet },
    { href: '/preview/control-plane/team', label: 'Team', icon: Users },
    { href: '/preview/control-plane/support', label: 'Support', icon: LifeBuoy },
    { href: '/preview/control-plane/activity', label: 'Activity', icon: Activity },
    { href: '/preview/control-plane/settings', label: 'Settings', icon: Settings },
  ],
};

const ONBOARDING_NAV: NavGroup = {
  label: 'Onboarding (preview)',
  items: [
    { href: '/preview/onboarding/business-info', label: 'Business info', icon: Building2 },
    { href: '/preview/onboarding/choose-agent', label: 'Choose agent', icon: Sparkles },
    { href: '/preview/onboarding/connect-channel', label: 'Connect channel', icon: Plug },
    { href: '/preview/onboarding/provisioning', label: 'Provisioning', icon: ShieldCheck },
    { href: '/preview/onboarding/first-use', label: 'First use', icon: Home },
  ],
};

export function PreviewSidebar({ userName, tenantName }: { userName: string; tenantName: string }) {
  const initials = userName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <Sidebar variant="sidebar" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="cursor-default hover:bg-transparent active:bg-transparent">
              <Link href="/preview">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Command className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="font-semibold truncate">Isola</span>
                  <span className="text-xs text-sidebar-foreground/60 truncate">{tenantName}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <div className="mx-2 mt-1 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs font-medium text-amber-700 dark:text-amber-400 group-data-[collapsible=icon]:hidden">
          <Eye className="size-3.5 shrink-0" /> Preview mode — mock data only
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavMain groups={[CONTROL_PLANE_NAV, ONBOARDING_NAV]} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <Avatar className="size-7 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-primary/10 text-primary text-xs font-semibold">
                      {initials || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="font-medium truncate">{userName}</span>
                    <span className="text-xs text-sidebar-foreground/60 truncate">Owner (preview)</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem asChild>
                  <Link href="/" className="cursor-pointer">
                    Exit preview
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
