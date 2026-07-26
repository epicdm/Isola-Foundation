import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type ProvisioningStepState = 'done' | 'active' | 'todo';
export interface ProvisioningStep { id: string; title: string; note: string; state: ProvisioningStepState }

const TAG: Record<ProvisioningStepState, { label: string; cls: string; mark: string }> = {
  done: { label: 'Done', cls: 'bg-primary/10 text-primary', mark: '\u2713' },
  active: { label: 'In progress', cls: 'bg-warning/10 text-warning-foreground', mark: '\u2026' },
  todo: { label: 'To do', cls: 'bg-muted text-muted-foreground', mark: '\u25cb' },
};

// ProvisioningProgress — human-readable activation steps. Never names the backend
// system doing the work; "what EPIC is handling" / "what you need to do" stays separate.
// Fix (review item 5): semantic role="list"/role="listitem" and aria-current="step" on
// the active item, so assistive tech announces progress correctly, not just visually.
export function ProvisioningProgress({ steps }: { steps: ProvisioningStep[] }) {
  return (
    <div className="rounded-xl border bg-card p-5" role="list" aria-label="Activation progress">
      {steps.map((s, i) => {
        const t = TAG[s.state];
        return (
          <div key={s.id} role="listitem" aria-current={s.state === 'active' ? 'step' : undefined} className={cn('flex gap-3.5 py-3', i > 0 && 'border-t')}>
            <span className={cn('flex size-6.5 shrink-0 items-center justify-center rounded-full text-xs font-bold', t.cls)} aria-hidden="true">{t.mark}</span>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-sm font-semibold', s.state === 'todo' && 'text-muted-foreground')}>{s.title}</span>
                <Badge variant="secondary" className={cn('text-[11px]', t.cls)}>
                  <span className="sr-only">Status: </span>{t.label}
                </Badge>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.note}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
