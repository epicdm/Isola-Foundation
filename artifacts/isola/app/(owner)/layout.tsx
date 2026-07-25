import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AppSidebar } from '@/components/app-sidebar';
import { Topbar } from '@/components/topbar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getPreference } from '@/server/server-actions';
import { cn } from '@/lib/utils';

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    // Send them to the real OIDC login and bring them back to where they were
    // asking for, instead of dropping them on the public homepage. Middleware
    // catches the no-cookie case; this handles a cookie that is present but no
    // longer resolves to a session. The path comes from our own middleware
    // header, never from user input.
    const requested = (await headers()).get('x-isola-pathname') ?? '/dashboard';
    const safe = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/dashboard';
    redirect(`/auth/login?returnTo=${encodeURIComponent(safe)}`);
  }

  // Admin without act-as goes to admin panel
  if (session.isAdmin && !session.user.act_as_tenant_id) {
    redirect('/admin');
  }

  const actingAsTenantName = session.user.act_as_tenant_id
    ? session.effectiveTenant.business_name
    : null;

  const [variant, collapsible] = await Promise.all([
    getPreference('sidebar_variant'),
    getPreference('sidebar_collapsible'),
  ]);

  return (
    <SidebarProvider style={{ '--sidebar-width': 'calc(var(--spacing) * 68)' } as React.CSSProperties}>
      <AppSidebar
        userName={session.user.name ?? session.user.email ?? 'User'}
        userRole={session.isAdmin ? 'Admin (act-as)' : 'Owner'}
        tenantName={session.user.tenant.business_name}
        agentTookOver={session.user.agent_took_over}
        isAdmin={session.isAdmin}
        actingAsTenantName={actingAsTenantName}
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
        <Topbar isAdmin={session.isAdmin} showOwnerNav />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
