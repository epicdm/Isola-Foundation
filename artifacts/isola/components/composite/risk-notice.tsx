'use client';
import { Button } from '@/components/ui/button';

// RiskNotice / RecommendedNextAction — one visually distinct block naming a concrete
// blocker in plain language, with a single next action. Uses only existing Isola
// semantic tokens (--warning/--warning-foreground) — no arbitrary Tailwind colors.
export function RiskNotice({ title, body, actionLabel, onAction }: { title: string; body: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 p-4" role="alert">
      <div className="text-sm font-semibold text-warning-foreground">{title}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
      <Button size="sm" className="mt-2.5" onClick={onAction}>{actionLabel}</Button>
    </div>
  );
}
