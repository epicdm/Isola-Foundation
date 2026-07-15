'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Ported from Studio Admin's NavMain — grouped links with active-state highlighting. */
export function NavMain({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();

  return (
    <>
      {groups.map((group, i) => (
        <SidebarGroup key={group.label ?? i}>
          {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const isActive = item.href === '/admin' ? pathname === item.href : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
