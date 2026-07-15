import { redirect } from 'next/navigation';
import { getConsumerSession } from '@/lib/consumer-session';
import { ConsumerBottomNav } from '@/components/consumer/bottom-nav';
import { ConsumerServiceWorkerRegister } from '@/components/consumer/sw-register';
import { ConsumerLogoutButton } from '@/components/consumer/logout-button';
import { ConsumerThemeToggle } from '@/components/consumer/theme-toggle';

function formatDid(did: string | null): string {
  if (!did) return 'EMA';
  const d = did.replace(/^1/, '');
  if (d.length !== 10) return `+${did}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Morning';
  if (hour < 18) return 'Afternoon';
  return 'Evening';
}

export default async function ConsumerAppLayout({ children }: { children: React.ReactNode }) {
  const account = await getConsumerSession();
  if (!account) redirect('/consumer/login');

  const firstName = account.display_name?.trim().split(/\s+/)[0] || null;

  return (
    <div className="ema-texture mx-auto flex min-h-screen max-w-md flex-col" data-theme-preset="epic">
      <ConsumerServiceWorkerRegister />
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border/70 bg-background/80 px-4 py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-display text-sm font-extrabold text-primary-foreground">
            E
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-bold leading-tight">
              {timeGreeting()}{firstName ? `, ${firstName}` : ''}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{formatDid(account.magnus_did_number)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ConsumerThemeToggle />
          <ConsumerLogoutButton />
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-4 pb-28 pt-4">{children}</main>
      <ConsumerBottomNav />
    </div>
  );
}
