'use client';

import { LifeBuoy, PlusCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SUPPORT_REQUESTS } from '../../_lib/mock-data';
import { useMockCta } from '../../_lib/use-mock-cta';
import { MockCtaStatus } from '../../_components/mock-cta-status';

function statusVariant(status: string) {
  if (status === 'Open') return 'destructive' as const;
  if (status === 'In progress') return 'secondary' as const;
  return 'outline' as const;
}

export default function SupportPage() {
  const newRequest = useMockCta('Support request sent to Chatwoot — a person will follow up.');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Support</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Requests route to Chatwoot as the destination — same as the real{' '}
          <code className="rounded bg-muted px-1 py-0.5">supportRequest</code> adapter concept.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <LifeBuoy className="size-4 text-primary" /> New support request
          </div>
          <Textarea placeholder="Describe what you need help with…" className="min-h-[80px]" />
          <Button
            className="mt-3"
            size="sm"
            onClick={() => newRequest.run()}
            disabled={newRequest.state.phase === 'loading'}
          >
            <PlusCircle className="size-3.5" /> Submit (mock)
          </Button>
          <MockCtaStatus state={newRequest.state} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {SUPPORT_REQUESTS.map((r) => (
          <Card key={r.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="text-sm font-medium">
                  <span className="mr-2 text-xs text-muted-foreground">{r.id}</span>
                  {r.subject}
                </div>
                <div className="text-xs text-muted-foreground">Opened {r.created}</div>
              </div>
              <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
