import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export interface AttentionItem {
  id: string;
  icon: LucideIcon;
  title: string;
  sub: string;
  age?: string;
  cta: string;
  href: string;
  tone: 'info' | 'warning' | 'primary' | 'destructive';
}

const TONE: Record<AttentionItem['tone'], { accent: string; iconBg: string; btn: string; border: string }> = {
  info: { accent: 'text-blue-600 dark:text-blue-400', iconBg: 'bg-blue-500/10', btn: 'bg-blue-600 hover:bg-blue-700', border: 'border-l-blue-500' },
  warning: { accent: 'text-warning-foreground', iconBg: 'bg-warning/10', btn: 'bg-warning hover:bg-warning/90 text-warning-foreground', border: 'border-l-warning' },
  primary: { accent: 'text-primary', iconBg: 'bg-primary/10', btn: 'bg-primary hover:bg-primary/90 text-primary-foreground', border: 'border-l-primary' },
  destructive: { accent: 'text-destructive', iconBg: 'bg-destructive/10', btn: 'bg-destructive hover:bg-destructive/90 text-destructive-foreground', border: 'border-l-destructive' },
};

// AttentionQueue — the "what needs your attention" list. Each row names a concrete
// business outcome (never an internal engine/queue name) and links straight to the action.
// Fix (review item 5): responsive stacking below sm; tone border applied via an explicit
// per-tone border-l-* class (not a computed inline value that Tailwind can't see, which
// would get purged); age element omitted entirely (not blank) when not provided.
export function AttentionQueue({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
        Nothing needs your attention right now — nice work.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => {
        const t = TONE[it.tone];
        const Icon = it.icon;
        return (
          <div key={it.id} className={cn('flex flex-col gap-2.5 rounded-lg border border-l-[3px] bg-card p-3.5 pl-4 shadow-sm sm:flex-row sm:items-center sm:gap-3', t.border)}>
            <div className="flex flex-1 items-center gap-3 min-w-0">
              <span className={cn('flex size-8.5 shrink-0 items-center justify-center rounded-md', t.iconBg, t.accent)}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{it.title}</div>
                <div className="text-xs text-muted-foreground">{it.sub}</div>
              </div>
              {it.age && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{it.age}</span>}
            </div>
            <Link href={it.href} className={cn('shrink-0 rounded-md px-3 py-1.5 text-center text-xs font-semibold text-white', t.btn)}>
              {it.cta}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
