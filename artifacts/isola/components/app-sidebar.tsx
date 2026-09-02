'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutGrid,
  ListChecks,
  Inbox,
  Bot,
  Phone,
  Wallet,
  BarChart3,
  Building2,
  LogOut,
  Eye,
  PauseCircle,
  ChevronsUpDown,
  Command,
  HeartPulse,
  Activity,
  Users,
  Contact,
  ShieldCheck,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

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
import { usePreferencesStore } from '@/stores/preferences/preferences-provider';

interface AppSidebarProps {
  userName: string;
  userRole: string;
  tenantName: string;
  agentTookOver: boolean;
  isAdmin: boolean;
  actingAsTenantName?: string | null;
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}

const OWNER_NAV: NavGroup = {
  label: 'Workspace',
  items: [
    { href: '/workspace', label: 'Workspace', icon: ListChecks },
    { href: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
    { href: '/team', label: 'AI Team', icon: Users },
    { href: '/inbox', label: 'Inbox', icon: Inbox },
    // Sits beside Inbox and Activity because it is the same kind of thing: a
    // way in to daily work. Customer 360 shipped without one and was reachable
    // only by typing a URL, which is not a shipped feature.
    { href: '/customers', label: 'Customers', icon: Contact },
    { href: '/activity', label: 'Activity', icon: Activity },
    { href: '/agent', label: 'AI Agent', icon: Bot },
    { href: '/voice', label: 'Voice', icon: Phone },
    { href: '/wallet', label: 'Wallet', icon: Wallet },
    { href: '/plan', label: 'Plan & Usage', icon: BarChart3 },
  ],
};

const ADMIN_NAV: NavGroup = {
  label: 'Admin',
  items: [
    { href: '/admin', label: 'Admin', icon: Building2 },
    { href: '/admin/plans', label: 'Plans & Rates', icon: BarChart3 },
    { href: '/admin/voice-health', label: 'Voice Health', icon: HeartPulse },
  ],
};

/**
 * Ported from Studio Admin's AppSidebar (grouped NavMain + zustand-driven layout
 * preferences) with Isola's act-as / agent-takeover banners and auth preserved exactly.
 */
export function AppSidebar({
  userName,
  userRole,
  tenantName,
  agentTookOver,
  isAdmin,
  actingAsTenantName,
  ...props
}: AppSidebarProps) {
  const router = useRouter();
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.values.sidebar_variant,
      sidebarCollapsible: s.values.sidebar_collapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant ?? 'sidebar';
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible ?? 'icon';

  const showOwnerNav = !isAdmin || !!actingAsTenantName;

  // POST + explicit navigation only — this must never be a <Link href>. Next.js
  // prefetches any Link in the viewport (a background GET), and this banner is
  // visible on every owner page while acting-as, so a prefetchable link here
  // would silently clear act_as_tenant_id seconds after it's set.
  async function exitActAs() {
    await fetch('/api/admin/act-as-clear', { method: 'POST' });
    router.push('/admin');
    router.refresh();
  }

  const initials = userName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <Sidebar variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="cursor-default hover:bg-transparent active:bg-transparent">
              <Link href="/dashboard">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Command className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Isola</span>
                  <span className="truncate text-xs text-sidebar-foreground/60">
                    {actingAsTenantName ?? tenantName}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {actingAsTenantName && (
          <div className="mx-2 mt-1 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400 group-data-[collapsible=icon]:hidden">
            <div className="flex items-center gap-1.5 font-medium">
              <Eye className="size-3.5" /> Acting as tenant
            </div>
            <button type="button" onClick={exitActAs} className="mt-1 underline underline-offset-2">
              Exit act-as &rarr;
            </button>
          </div>
        )}

        {agentTookOver && !isAdmin && (
          <div className="mx-2 mt-1 flex items-center gap-1.5 rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs text-destructive group-data-[collapsible=icon]:hidden">
            <PauseCircle className="size-3.5" /> AI paused — you have control
          </div>
        )}
      </SidebarHeader>

      <SidebarContent>
        {/* This sidebar only renders inside the tenant workspace, so the tenant
            navigation is always primary — an administrator who deliberately
            opened a tenant route must not be shown the operator navigation in
            its place. The console remains reachable as a clearly separate
            secondary group and from the switch in the footer. */}
        <NavMain groups={[OWNER_NAV]} />

        {isAdmin && <NavMain groups={[ADMIN_NAV]} />}
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
                    <span className="truncate font-medium">{userName}</span>
                    <span className="truncate text-xs text-sidebar-foreground/60">{userRole}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                {/* Explicit, deliberate realm switch. Shown only to a platform
                    administrator; tenant and operator data are never mixed in
                    one context — this navigates to the separate console. */}
                {isAdmin && (
                  <DropdownMenuItem asChild>
                    <a href="/admin" className="cursor-pointer">
                      <ShieldCheck className="mr-2 size-4" /> Open Operator Console
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  {/* Real OIDC end-session route on artifacts/api-server; it
                      clears the sid cookie and returns to the public homepage. */}
                  <a href="/auth/logout?returnTo=%2F" className="cursor-pointer">
                    <LogOut className="mr-2 size-4" /> Sign out
                  </a>
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
