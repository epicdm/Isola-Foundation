'use client';
// A tiny idle/loading/success/error state machine for simulated async actions
// on the owner visual-review preview, shaped after components/foh/cta-panel.tsx's
// CtaState pattern. No network call is ever made — this only fakes latency so
// the preview shows what a real submit would feel like.
import { useCallback, useState } from 'react';

export type MockCtaPhase = 'idle' | 'loading' | 'success' | 'error';

export interface MockCtaState {
  phase: MockCtaPhase;
  message?: string;
}

export function useMockCta(successMessage: string, delayMs = 650) {
  const [state, setState] = useState<MockCtaState>({ phase: 'idle' });

  const run = useCallback(async () => {
    setState({ phase: 'loading' });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    setState({ phase: 'success', message: successMessage });
  }, [successMessage, delayMs]);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, run, reset };
}
