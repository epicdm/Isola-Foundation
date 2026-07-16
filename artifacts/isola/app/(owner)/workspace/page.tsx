import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getWorkQueue } from '@/lib/workspace-queue';
import { WorkspaceQueueTable } from '@/components/workspace-queue-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Briefcase, MessageCircle, PhoneMissed, ShieldCheck } from 'lucide-react';

export const metadata = { title: 'Workspace' };
export const revalidate = 0;

export default async function WorkspacePage() {
  const session = await getSession();
  if (!session) redirect('/');

  const queue = await getWorkQueue(session);

  const stats = [
    { label: 'Tasks', value: queue.counts.odoo_task, icon: Briefcase },
    { label: 'Conversations', value: queue.counts.conversation, icon: MessageCircle },
    { label: 'Voicemail', value: queue.counts.voicemail, icon: PhoneMissed },
    { label: 'Approvals', value: queue.counts.approval, icon: ShieldCheck },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
          <p className="text-sm text-muted-foreground">Your open items across tasks, inbox, voicemail, and approvals.</p>
        </div>
        <Badge variant="secondary" className="capitalize">
          {queue.rank} · {queue.scope === 'all' ? 'tenant-wide' : 'your items'}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </CardTitle>
              <s.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {queue.items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <ShieldCheck className="size-8 text-muted-foreground" />
            <div>Your queue is clear.</div>
            <div className="text-sm text-muted-foreground">
              New tasks, conversations, voicemail, and approvals will show up here.
            </div>
          </CardContent>
        </Card>
      ) : (
        <WorkspaceQueueTable data={queue.items} />
      )}
    </div>
  );
}
