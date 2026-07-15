'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TakeoverToggle({ agentTookOver }: { agentTookOver: boolean }) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState(agentTookOver);
  const router = useRouter();

  async function toggle() {
    const next = !optimistic;
    setOptimistic(next); // immediate UI feedback
    try {
      const res = await fetch('/api/agent/takeover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        setOptimistic(!next); // revert on error
        console.error('[takeover] Failed:', await res.text());
        return;
      }
    } catch {
      setOptimistic(!next);
    }
    startTransition(() => router.refresh());
  }

  return (
    <Button
      onClick={toggle}
      disabled={pending}
      size="sm"
      variant={optimistic ? 'destructive' : 'secondary'}
    >
      {optimistic ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
      {pending ? '…' : optimistic ? 'Resume AI' : 'Take over'}
    </Button>
  );
}
