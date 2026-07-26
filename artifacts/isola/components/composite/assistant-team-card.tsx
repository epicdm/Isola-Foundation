'use client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface AssistantTeamMember {
  id: string;
  name: string;
  job: string;
  status: 'Active' | 'Needs approval' | 'Paused';
  channels: string[];
  currentWork: string;
  outcome: string;
  handoff: string;
  paused: boolean;
  onConfigure: () => void;
  onTogglePause: () => void;
}

const STATUS_VARIANT: Record<AssistantTeamMember['status'], 'default' | 'secondary' | 'destructive'> = {
  Active: 'default',
  'Needs approval': 'secondary',
  Paused: 'secondary',
};

// AssistantTeamCard — presents an assistant as a team member with a job, not a model.
// Fix (review item 5): marked 'use client' since it owns onConfigure/onTogglePause
// callbacks — a Server Component page must pass server actions or a thin client
// wrapper, not raw closures, when rendering this. No runtime/model/engine name is
// ever rendered here; that vocabulary stays in internal-only surfaces.
export function AssistantTeamCard({ m }: { m: AssistantTeamMember }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{m.name}</div>
            <div className="text-xs text-muted-foreground">{m.job}</div>
          </div>
          <Badge variant={STATUS_VARIANT[m.status]}>{m.status}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.channels.map((c) => <Badge key={c} variant="secondary" className="text-[11px]">{c}</Badge>)}
        </div>
        <dl className="mt-3.5 space-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1"><dt className="shrink-0">Currently:</dt><dd className="text-foreground">{m.currentWork}</dd></div>
          <div className="flex gap-1"><dt className="shrink-0">Outcome:</dt><dd className="text-foreground">{m.outcome}</dd></div>
          <div className="flex gap-1"><dt className="shrink-0">Handoff:</dt><dd className="text-foreground">{m.handoff}</dd></div>
        </dl>
        <div className="mt-4 flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={m.onConfigure}>Configure</Button>
          <Button size="sm" variant={m.paused ? 'default' : 'secondary'} className="flex-1" onClick={m.onTogglePause} aria-pressed={m.paused}>
            {m.paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
