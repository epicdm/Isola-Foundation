import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, Wallet, Bot, PhoneCall, ArrowRight, Zap } from 'lucide-react';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage, getUsageHistory } from '@/lib/meter';
import { WHATSAPP_NUMBER_PUBLIC_SELECT } from '@/lib/whatsapp-number-public';
import { TakeoverToggle } from './TakeoverToggle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { UsageChart, type UsagePoint } from '@/components/usage-chart';
import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { AttentionQueue, type AttentionItem } from '@/components/composite/attention-queue';
import { OutcomeMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { EmptyState } from '@/components/composite/empty-state';

export const metadata = { title: 'Dashboard' };
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

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/');
  const tenantId = session.effectiveTenantId;

  const [openConvs, waNumbers, wallet, agent, usage, usageHistory, recentConversations] = await Promise.all([
    prisma.conversation.count({ where: { tenant_id: tenantId, status: 'open' } }),
    // CB-0 defence in depth. This server component renders only phone_number
    // and display_name, so the token was never serialised into the RSC payload
    // — but the raw row was still being read, and one refactor that passes
    // `waNumbers` to a client component would have turned that into a leak.
    // Same projection the API boundary uses.
    prisma.whatsAppNumber.findMany({
      where: { tenant_id: tenantId },
      select: WHATSAPP_NUMBER_PUBLIC_SELECT,
    }),
    prisma.wallet.findUnique({ where: { tenant_id: tenantId } }),
    prisma.agent.findFirst({ where: { tenant_id: tenantId } }),
    getCurrentUsage(tenantId),
    getUsageHistory(tenantId, 6),
    prisma.conversation.findMany({
      where: { tenant_id: tenantId },
      include: { messages: { orderBy: { created_at: 'desc' }, take: 1 } },
      orderBy: { last_message_at: 'desc' },
      take: 5,
    }),
  ]);

  const isOnboarded = waNumbers.length > 0;

  const chartData: UsagePoint[] = usageHistory.map((row) => ({
    month: row.period_start.toLocaleDateString(undefined, { month: 'short' }),
    tokens: row.tokens_used,
    minutes: Number(row.minutes_used.toFixed(1)),
  }));

  // Attention queue: concrete business exceptions, not raw system state. Extend this
  // list as more attention-worthy conditions (overdue invoice, verification rejected,
  // provisioning failure) get real backing data.
  const attention: AttentionItem[] = [];
  if (!isOnboarded) {
    attention.push({ id: 'onboard', icon: Zap, title: 'Connect WhatsApp to get started', sub: 'Your AI agent is ready — it just needs a number to respond from.', age: '', cta: 'Connect', href: '/onboard', tone: 'primary' });
  }
  // NOTE: no approved low-balance threshold exists yet (Port/product has not ratified one).
  // Do not invent a number — this attention item is intentionally omitted until a
  // configured threshold (e.g. a per-plan or per-tenant setting) is approved and available.
  if (openConvs > 0) {
    attention.push({ id: 'open-convs', icon: MessageSquare, title: `${openConvs} open conversation${openConvs === 1 ? '' : 's'} in your inbox`, sub: 'Review and reply when you\'re ready.', age: '', cta: 'View inbox', href: '/inbox', tone: 'info' });
  }

  const metrics: OutcomeMetric[] = [
    { label: 'Open Conversations', value: openConvs.toLocaleString(), icon: MessageSquare, href: '/inbox', trend: 'View inbox', trendTone: 'positive' },
    { label: 'Wallet Balance', value: wallet ? `${wallet.currency} ${wallet.balance_cache.toFixed(2)}` : '—', icon: Wallet, href: '/wallet', trend: 'Top up', trendTone: 'positive' },
    { label: 'AI Usage (tokens)', value: (usage?.tokens_used ?? 0).toLocaleString(), icon: Bot, trend: 'tokens consumed this month' },
    { label: 'Call Minutes (this month)', value: usage ? usage.minutes_used.toFixed(1) : '0', icon: PhoneCall, trend: `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usage?.minutes_cost ?? 0)} billed` },
  ];

  return (
    <div className="flex flex-col gap-6">
      <OwnerPageHeader
        eyebrow={session.effectiveTenant.business_name}
        title="What needs your attention"
        actions={agent ? <TakeoverToggle agentTookOver={session.user.agent_took_over} /> : undefined}
      />

      <AttentionQueue items={attention} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => <OutcomeMetricCard key={m.label} metric={m} />)}
      </div>

      <UsageChart data={chartData} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">AI Agent</CardTitle></CardHeader>
          <CardContent>
            {agent ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <div className="font-semibold">{agent.name}</div>
                  <Badge variant={agent.is_active ? 'default' : 'destructive'}>{agent.is_active ? 'Active' : 'Paused'}</Badge>
                </div>
                <div className="text-sm text-muted-foreground">Tier: <span className="font-medium text-foreground">{agent.intelligence_tier}</span></div>
                <Button asChild size="sm" variant="secondary" className="mt-3"><Link href="/agent">Configure <ArrowRight className="size-3.5" /></Link></Button>
              </>
            ) : <p className="text-sm text-muted-foreground">No agent configured.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">WhatsApp Numbers</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {waNumbers.length === 0 ? (
              <EmptyState icon={MessageSquare} title="No numbers connected yet" body="Connect WhatsApp to start receiving messages." variant="inline" />
            ) : waNumbers.map((n) => (
              <div key={n.id} className="flex items-center justify-between">
                <div><div className="text-sm font-medium">{n.phone_number}</div><div className="text-xs text-muted-foreground">{n.display_name ?? 'No display name'}</div></div>
                <Badge>Active</Badge>
              </div>
            ))}
            <Button asChild size="sm" variant="ghost" className="self-start"><Link href="/onboard">{waNumbers.length ? 'Add another' : 'Connect now'} <ArrowRight className="size-3.5" /></Link></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Recent conversations</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {recentConversations.length === 0 ? (
              <EmptyState icon={MessageSquare} title="No conversations yet" body="Conversations will appear here once customers reach out." variant="inline" />
            ) : recentConversations.map((c) => {
              const lastMsg = c.messages[0];
              const name = c.customer_name ?? c.customer_phone;
              const initials = name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
              return (
                <Link key={c.id} href={`/inbox/${c.id}`} className="flex items-center gap-3 rounded-md p-1 -m-1 hover:bg-accent">
                  <Avatar className="size-8"><AvatarFallback className="text-xs">{initials}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{name}</div>
                    {lastMsg && <div className="truncate text-xs text-muted-foreground">{lastMsg.content}</div>}
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">{relativeTime(c.last_message_at)}</div>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
