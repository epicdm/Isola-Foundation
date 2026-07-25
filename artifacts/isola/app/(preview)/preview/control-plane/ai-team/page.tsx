import Link from 'next/link';
import { ArrowRight, Bot, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AGENTS } from '../../_lib/mock-data';

function statusVariant(status: string) {
  if (status === 'Live') return 'default' as const;
  if (status === 'Assisted') return 'secondary' as const;
  return 'outline' as const;
}

export default function AiTeamPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI Team</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every AI employee working for this business, and which channels they cover.
          </p>
        </div>
        <Button size="sm" variant="secondary">
          <Sparkles className="size-3.5" /> Hire a new AI employee
        </Button>
      </div>

      <p className="max-w-2xl rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-amber-800 dark:text-amber-300">
        Today&apos;s real <code className="rounded bg-background/60 px-1 py-0.5">/agent</code> page manages one AI
        employee; this roster view is the proposed multi-agent expansion.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {AGENTS.map((a) => (
          <Card key={a.id}>
            <CardHeader className="pb-3">
              <div className="mb-1 flex items-center justify-between">
                <Bot className="size-5 text-primary" />
                <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
              </div>
              <CardTitle className="text-base">{a.name}</CardTitle>
              <p className="text-xs text-muted-foreground">{a.role}</p>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {a.channels.length ? (
                  a.channels.map((c) => (
                    <Badge key={c} variant="outline">
                      {c}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">No channel assigned yet</span>
                )}
              </div>
              <Button asChild size="sm" variant="secondary" className="w-full">
                <Link href={`/preview/control-plane/ai-team/${a.id}`}>
                  Configure <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
