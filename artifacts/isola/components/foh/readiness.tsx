import { cn } from '@/lib/utils';
import type { Readiness as R } from '@/lib/foh/catalog';
const MAP: Record<string, string> = {
  Live: 'bg-success/10 text-success border-success/25',
  Assisted: 'bg-warning/10 text-warning-foreground border-warning/30',
  Conditional: 'bg-accent text-accent-foreground border-accent',
  Planned: 'bg-muted text-muted-foreground border-border',
  'Not offered': 'bg-muted text-muted-foreground border-border',
};
const DOT: Record<string, string> = { Live: 'bg-success', Assisted: 'bg-warning', Conditional: 'bg-primary', Planned: 'bg-muted-foreground', 'Not offered': 'bg-muted-foreground' };
export function ReadinessBadge({ state }: { state: R }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold', MAP[state])}>
      <span className={cn('size-1.5 rounded-full', DOT[state])} /> {state}
    </span>
  );
}
export function DualState({ engine, isola }: { engine: R; isola: R }) {
  return (
    <div className="flex flex-wrap gap-4">
      <div><div className="mb-1 text-[11px] font-semibold text-muted-foreground">Engine state</div><ReadinessBadge state={engine} /></div>
      <div><div className="mb-1 text-[11px] font-semibold text-muted-foreground">Isola experience</div><ReadinessBadge state={isola} /></div>
    </div>
  );
}
