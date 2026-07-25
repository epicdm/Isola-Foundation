import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ACTIVITY } from '../../_lib/mock-data';

export default function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A high-level audit feed of what happened across this business — not a message thread.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {ACTIVITY.map((item) => (
              <li key={item.id} className="flex items-start gap-3 p-4">
                <Activity className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="text-sm">{item.text}</div>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">{item.ts}</div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
