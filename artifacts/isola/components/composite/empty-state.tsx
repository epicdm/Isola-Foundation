import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EmptyStateVariant = 'card' | 'inline' | 'page';

const VARIANT_CLS: Record<EmptyStateVariant, string> = {
  card: 'rounded-xl border border-dashed p-10',
  inline: 'rounded-md p-4',
  page: 'rounded-xl border border-dashed p-16',
};

// EmptyState — standard "nothing here yet" pattern.
// Fix (review item 5): three variants for three real contexts — a dashed-border card
// inside a page (default), a compact inline row (e.g. inside a table body), and a
// full-page treatment for a route whose ENTIRE content is empty (larger padding, icon).
export function EmptyState({ icon: Icon, title, body, action, variant = 'card' }: { icon: LucideIcon; title: string; body: string; action?: ReactNode; variant?: EmptyStateVariant }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 text-center', VARIANT_CLS[variant])}>
      <Icon className={cn('text-muted-foreground', variant === 'page' ? 'size-10' : 'size-8')} />
      <div className="text-sm font-semibold">{title}</div>
      <p className="max-w-[36ch] text-xs text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}
