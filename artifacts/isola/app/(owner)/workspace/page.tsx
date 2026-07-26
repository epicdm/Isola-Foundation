import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getWorkQueue } from '@/lib/workspace-queue';
import { WorkspaceQueueTable } from '@/components/workspace-queue-table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Briefcase, MessageCircle, PhoneMissed, ShieldCheck } from 'lucide-react';
import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { OutcomeMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { EmptyState } from '@/components/composite/empty-state';

export const metadata = { title: 'Workspace' };
export const revalidate = 0;

export default async function WorkspacePage() {
  const session = await getSession();
  if (!session) redirect('/');

  const queue = await getWorkQueue(session);

  const metrics: OutcomeMetric[] = [
    { label: 'Tasks', value: String(queue.counts.odoo_task), icon: Briefcase },
    { label: 'Conversations', value: String(queue.counts.conversation), icon: MessageCircle },
    { label: 'Voicemail', value: String(queue.counts.voicemail), icon: PhoneMissed },
    { label: 'Approvals', value: String(queue.counts.approval), icon: ShieldCheck },
  ];

  return (
    <div className="flex flex-col gap-5">
      <OwnerPageHeader
        eyebrow={`${queue.rank} · ${queue.scope === 'all' ? 'tenant-wide' : 'your items'}`}
        title="Workspace"
        actions={<Badge variant="secondary" className="capitalize">{queue.rank}</Badge>}
      />
      <p className="-mt-3 text-sm text-muted-foreground">Your open items across tasks, inbox, voicemail, and approvals.</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => <OutcomeMetricCard key={m.label} metric={m} />)}
      </div>

      {queue.items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Your queue is clear" body="New tasks, conversations, voicemail, and approvals will show up here." />
      ) : (
        <WorkspaceQueueTable data={queue.items} />
      )}
    </div>
  );
}
