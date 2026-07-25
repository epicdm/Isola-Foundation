import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ONBOARDING_STEPS } from '../_lib/onboarding-steps';

export function OnboardingProgress({ current }: { current: number }) {
  return (
    <ol className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-3 text-xs font-medium sm:gap-x-3">
      {ONBOARDING_STEPS.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'upcoming';
        return (
          <li key={step.href} className="flex items-center gap-2">
            <Link
              href={step.href}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors',
                state === 'active' && 'border-primary bg-primary/10 text-primary',
                state === 'done' && 'border-success/30 bg-success/10 text-success',
                state === 'upcoming' && 'border-border text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full text-[10px]',
                  state === 'active' && 'bg-primary text-primary-foreground',
                  state === 'done' && 'bg-success text-success-foreground',
                  state === 'upcoming' && 'bg-muted text-muted-foreground',
                )}
              >
                {state === 'done' ? <Check className="size-2.5" /> : i + 1}
              </span>
              {step.label}
            </Link>
            {i < ONBOARDING_STEPS.length - 1 && <span className="text-border">&rarr;</span>}
          </li>
        );
      })}
    </ol>
  );
}
