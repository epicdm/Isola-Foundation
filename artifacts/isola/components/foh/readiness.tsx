import { cn } from '@/lib/utils';
import type { Readiness as R } from '@/lib/foh/catalog';

// INTERNAL ONLY — raw governance state (Live/Assisted/Conditional/Planned). Use only on
// internal delivery/Port/implementation-review surfaces, never on public marketing pages.
const MAP: Record<string, string> = {
  Live: 'bg-success/10 text-success border-success/25',
  Assisted: 'bg-warning/10 text-warning-foreground border-warning/30',
  Conditional: 'bg-accent text-accent-foreground border-accent',
  Planned: 'bg-muted text-muted-foreground border-border',
  'Not offered': 'bg-muted text-muted-foreground border-border',
};
const DOT: Record<string, string> = { Live: 'bg-success', Assisted: 'bg-warning', Conditional: 'bg-primary', Planned: 'bg-muted-foreground', 'Not offered': 'bg-muted-foreground' };

export function InternalReadinessBadge({ state }: { state: R }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold', MAP[state])}>
      <span className={cn('size-1.5 rounded-full', DOT[state])} /> {state}
    </span>
  );
}

// INTERNAL ONLY — pairs engine capability with Isola experience readiness. Never on public pages.
export function DualState({ engine, isola }: { engine: R; isola: R }) {
  return (
    <div className="flex flex-wrap gap-4">
      <div><div className="mb-1 text-[11px] font-semibold text-muted-foreground">Engine state</div><InternalReadinessBadge state={engine} /></div>
      <div><div className="mb-1 text-[11px] font-semibold text-muted-foreground">Isola experience</div><InternalReadinessBadge state={isola} /></div>
    </div>
  );
}

// PUBLIC — customer-facing wording. This is the ONLY badge marketing/catalogue/product pages may use.
const CUSTOMER_LABEL: Record<string, string> = {
  Live: 'Available',
  Assisted: 'Assisted setup by EPIC',
  Conditional: 'Available with assisted setup',
  Planned: 'Join the waitlist',
  'Not offered': 'Not offered',
};
const CUSTOMER_CLASS: Record<string, string> = {
  Live: 'bg-success/10 text-success border-success/25',
  Assisted: 'bg-warning/10 text-warning-foreground border-warning/30',
  Conditional: 'bg-accent text-accent-foreground border-accent',
  Planned: 'bg-muted text-muted-foreground border-border',
  'Not offered': 'bg-muted text-muted-foreground border-border',
};
export function CustomerAvailabilityBadge({ state }: { state: R }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold', CUSTOMER_CLASS[state])}>
      <span className={cn('size-1.5 rounded-full', DOT[state])} /> {CUSTOMER_LABEL[state]}
    </span>
  );
}
