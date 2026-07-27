import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { InboxDataTable, type ConversationRow } from '@/components/inbox-data-table';
import { Button } from '@/components/ui/button';
import { MessageCircle } from 'lucide-react';
import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { EmptyState } from '@/components/composite/empty-state';

export const metadata = { title: 'Inbox' };
export const revalidate = 0;

function relativeTime(date: Date | null): string {
  if (!date) return '—';
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(date).toLocaleDateString();
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/');

  const sp = await searchParams;
  const statusFilter = sp?.status ?? 'open';
  const tenantId = session.effectiveTenantId;

  const conversations = await prisma.conversation.findMany({
    where: {
      tenant_id: tenantId,
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
    },
    include: {
      messages: { orderBy: { created_at: 'desc' }, take: 1 },
    },
    orderBy: { last_message_at: 'desc' },
    take: 60,
  });

  const openCount = await prisma.conversation.count({ where: { tenant_id: tenantId, status: 'open' } });
  const resolvedCount = await prisma.conversation.count({ where: { tenant_id: tenantId, status: 'resolved' } });

  const rows: ConversationRow[] = conversations.map((conv) => {
    const lastMsg = conv.messages[0];
    const ts = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
    return {
      id: conv.id,
      name: conv.customer_name ?? conv.customer_phone,
      status: conv.status,
      agentTookOver: conv.agent_took_over,
      lastMessage: lastMsg?.content ?? null,
      lastMessageFromAgent: lastMsg?.role === 'assistant',
      time: relativeTime(conv.last_message_at),
      timestamp: ts,
    };
  });

  return (
    <div className="flex flex-col gap-5">
      <OwnerPageHeader title="Inbox" eyebrow="WhatsApp conversations routed through your AI agent" />

      <div className="flex gap-2">
        {[
          { label: `Open (${openCount})`, value: 'open' },
          { label: `Resolved (${resolvedCount})`, value: 'resolved' },
          { label: 'All', value: 'all' },
        ].map((f) => (
          <Button key={f.value} asChild size="sm" variant={statusFilter === f.value ? 'default' : 'secondary'}>
            <Link href={`/inbox?status=${f.value}`}>{f.label}</Link>
          </Button>
        ))}
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title={`No ${statusFilter === 'all' ? '' : statusFilter + ' '}conversations yet`}
          body="Messages will appear here once WhatsApp is connected."
          variant="page"
        />
      ) : (
        <InboxDataTable data={rows} />
      )}
    </div>
  );
}
