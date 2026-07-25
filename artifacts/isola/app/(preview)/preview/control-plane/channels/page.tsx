import { Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadinessBadge } from '@/components/foh/readiness';
import { CHANNELS } from '../../_lib/mock-data';

export default function ChannelsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Channels</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every number and channel this business can be reached on.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {CHANNELS.map((ch) => (
          <Card key={ch.id}>
            <CardHeader className="pb-3">
              <div className="mb-1 flex items-center justify-between">
                <Phone className="size-5 text-primary" />
                <ReadinessBadge state={ch.status} />
              </div>
              <CardTitle className="text-base">{ch.name}</CardTitle>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{ch.kind}</p>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{ch.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
