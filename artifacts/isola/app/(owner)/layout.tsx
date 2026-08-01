import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionResult } from '@/lib/session';
import { loginDestination, safePath } from '@/lib/auth-gate';
import { AuthServiceUnavailable } from '@/components/auth/auth-service-unavailable';
import { resolveWorkspaceAuthz, workspaceRoleLabel } from '@/lib/workspace/authz';
import { AppSidebar } from '@/components/app-sidebar';
import { Topbar } from '@/components/topbar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getPreference } from '@/server/server-actions';
import { cn } from '@/lib/utils';

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const result = await getSessionResult();
  // The path comes from our own middleware header, never from user input, and
  // is re-checked by safePath anyway so both ends of the redirect agree.
  const requested = (await headers()).get('x-isola-pathname');

  // We could not find out who this is. NOT the same as finding out that nobody
  // is here -- so nothing is redirected, nothing is discarded, and the reader is
  // told plainly that this is our problem and their session is intact. Sending
  // them to /auth/login here would put them through an OAuth consent screen,
  // because that route sets prompt: 'login consent'
  // (defect-owner-layout-dependency-outage-rendered-as-logout).
  if (result.status === 'unavailable') {
    return <AuthServiceUnavailable detail={result.detail} retryTo={safePath(requested)} />;
  }

  // Genuinely signed out, on the authority of the sign-in service. Send them to
  // the real OIDC login and bring them back to where they were asking for,
  // instead of dropping them on the public homepage. Middleware catches the
  // no-cookie case; this handles a cookie that is present but no longer
  // resolves to a session.
  if (result.status === 'anonymous') {
    redirect(loginDestination(requested));
  }

  const session = result.session;

  // A platform administrator is NOT automatically sent to the operator console.
  // These are tenant routes; asking for one is an explicit choice of the tenant
  // realm, and the operator console stays reachable through its own explicit
  // entry (/admin, plus the switch in the sidebar). Previously an admin loading
  // /team was silently bounced to /admin, so the owner could never reach their
  // own workspace (defect-isola-owner-login-lands-saas-operator-2026-07-25).
  const authz = await resolveWorkspaceAuthz(session);

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
        userRole={workspaceRoleLabel(authz)}
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
