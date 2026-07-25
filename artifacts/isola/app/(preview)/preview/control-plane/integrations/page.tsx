import { Plug } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { INTEGRATIONS } from '../../_lib/mock-data';

export default function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The external engines this tenant is wired to. Isola never rebuilds what these already own.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {INTEGRATIONS.map((i) => (
          <Card key={i.id}>
            <CardHeader className="pb-3">
              <div className="mb-1 flex items-center justify-between">
                <Plug className="size-5 text-primary" />
                <Badge variant={i.status === 'Connected' ? 'default' : 'outline'}>{i.status}</Badge>
              </div>
              <CardTitle className="text-base">{i.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{i.desc}</p>
              <p className="mt-3 text-xs text-muted-foreground">Last synced {i.lastSynced} (mock)</p>
              <Button size="sm" variant="outline" className="mt-3" disabled>
                Reconfigure
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
