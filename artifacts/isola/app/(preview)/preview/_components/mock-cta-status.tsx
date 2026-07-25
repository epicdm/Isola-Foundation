'use client';
import { Check, Loader2 } from 'lucide-react';
import type { MockCtaState } from '../_lib/use-mock-cta';

/** Inline status renderer for useMockCta — mirrors components/foh/cta-panel.tsx's CtaState look. */
export function MockCtaStatus({ state }: { state: MockCtaState }) {
  const box = 'mt-3 flex items-start gap-2.5 rounded-md border p-3 text-[13px] leading-normal';
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return (
      <div className={box + ' bg-muted text-muted-foreground'}>
        <Loader2 className="size-4 shrink-0 animate-spin" /> Working on it (simulated)…
      </div>
    );
  }
  if (state.phase === 'success') {
    return (
      <div className={box + ' border-success/25 bg-success/10 text-success'}>
        <Check className="size-4 shrink-0" /> {state.message}
      </div>
    );
  }
  return null;
}
