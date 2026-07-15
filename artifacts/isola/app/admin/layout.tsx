import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AppSidebar } from '@/components/app-sidebar';
import { Topbar } from '@/components/topbar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getPreference } from '@/server/server-actions';
import { cn } from '@/lib/utils';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/');
  if (!session.isAdmin) redirect('/dashboard');

  const [variant, collapsible] = await Promise.all([
    getPreference('sidebar_variant'),
    getPreference('sidebar_collapsible'),
  ]);

  return (
    <SidebarProvider style={{ '--sidebar-width': 'calc(var(--spacing) * 68)' } as React.CSSProperties}>
      <AppSidebar
        userName={session.user.name ?? session.user.email ?? 'Admin'}
        userRole="Admin"
        tenantName={session.user.tenant.business_name}
        agentTookOver={false}
        isAdmin
        actingAsTenantName={null}
        variant={variant}
        collapsible={collapsible}
      />
      <SidebarInset
        className={cn(
          '[html[data-content-layout=centered]_&>*]:mx-auto',
          '[html[data-content-layout=centered]_&>*]:w-full',
          '[html[data-content-layout=centered]_&>*]:max-w-screen-2xl',
          'peer-data-[variant=inset]:border',
          'min-w-0 overflow-x-clip',
        )}
      >
        <Topbar isAdmin showOwnerNav={false} />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
