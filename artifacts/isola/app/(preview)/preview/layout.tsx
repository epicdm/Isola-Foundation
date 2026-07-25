// Owner visual-review preview shell — the layout for everything under /preview/*.
//
// Deliberately does NOT call getSession()/prisma — this route group must render
// standalone, with no live Postgres or Replit OIDC auth, so an owner reviewer
// (or CI) can open it cold. See app/(preview)/preview/_components/preview-sidebar.tsx
// for why the sidebar is a local component (and why its nav groups live there,
// not here — this file is a Server Component and can't pass icon components
// as props into a Client Component).
import { AlertTriangle } from 'lucide-react';

import { Topbar } from '@/components/topbar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { PreviewSidebar } from './_components/preview-sidebar';
import { TENANT } from './_lib/mock-data';

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider style={{ '--sidebar-width': 'calc(var(--spacing) * 68)' } as React.CSSProperties}>
      <PreviewSidebar userName="Jordan Reyes" tenantName={TENANT.name} />
      <SidebarInset
        className={cn(
          '[html[data-content-layout=centered]_&>*]:mx-auto',
          '[html[data-content-layout=centered]_&>*]:w-full',
          '[html[data-content-layout=centered]_&>*]:max-w-screen-2xl',
          'peer-data-[variant=inset]:border',
          'min-w-0 overflow-x-clip',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-xs font-semibold text-amber-800 dark:text-amber-300 sm:px-6">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            PREVIEW / MOCK DATA — Owner Visual Review, not live. Nothing on these pages reads or writes a real
            backend.
          </span>
        </div>
        <Topbar isAdmin={false} showOwnerNav />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
