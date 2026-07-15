import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, Wallet, Bot, PhoneCall, ArrowRight, Zap } from 'lucide-react';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage, getUsageHistory } from '@/lib/meter';
import { TakeoverToggle } from './TakeoverToggle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { UsageChart, type UsagePoint } from '@/components/usage-chart';

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
    prisma.whatsAppNumber.findMany({ where: { tenant_id: tenantId } }),
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

  const stats = [
    {
      label: 'Open Conversations',
      value: openConvs.toLocaleString(),
      sub: 'View inbox',
      href: '/inbox',
      icon: MessageSquare,
    },
    {
      label: 'Wallet Balance',
      value: wallet ? `${wallet.currency} ${wallet.balance_cache.toFixed(2)}` : '—',
      sub: 'Top up',
      href: '/wallet',
      icon: Wallet,
    },
    {
      label: 'AI Turns (this month)',
      value: (usage?.tokens_used ?? 0).toLocaleString(),
      sub: 'tokens consumed',
      icon: Bot,
    },
    {
      label: 'Call Minutes (this month)',
      value: usage ? usage.minutes_used.toFixed(1) : '0',
      sub: `$${usage ? usage.minutes_cost.toFixed(2) : '0.00'} billed`,
      icon: PhoneCall,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{session.effectiveTenant.business_name}</p>
        </div>
        {agent && <TakeoverToggle agentTookOver={session.user.agent_took_over} />}
      </div>

      {!isOnboarded && (
        <Alert>
          <Zap className="size-4" />
          <AlertTitle>Connect WhatsApp to get started.</AlertTitle>
          <AlertDescription>
            Your AI agent is ready — it just needs a number to respond from.
            <div className="mt-2">
              <Button asChild size="sm" variant="secondary">
                <Link href="/onboard">
                  Connect WhatsApp <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

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
              {s.href ? (
                <Link href={s.href} className="text-xs text-primary hover:underline">
                  {s.sub} &rarr;
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground">{s.sub}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <UsageChart data={chartData} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">AI Agent</CardTitle>
          </CardHeader>
          <CardContent>
            {agent ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <div className="font-semibold">{agent.name}</div>
                  <Badge variant={agent.is_active ? 'default' : 'destructive'}>
                    {agent.is_active ? 'Active' : 'Paused'}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  Tier: <span className="font-medium text-foreground">{agent.intelligence_tier}</span>
                </div>
                <Button asChild size="sm" variant="secondary" className="mt-3">
                  <Link href="/agent">
                    Configure <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No agent configured.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">WhatsApp Numbers</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {waNumbers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No numbers connected yet.</p>
            ) : (
              waNumbers.map((n) => (
                <div key={n.id} className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{n.phone_number}</div>
                    <div className="text-xs text-muted-foreground">{n.display_name ?? 'No display name'}</div>
                  </div>
                  <Badge>Active</Badge>
                </div>
              ))
            )}
            <Button asChild size="sm" variant="ghost" className="self-start">
              <Link href="/onboard">
                {waNumbers.length ? 'Add another' : 'Connect now'} <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent conversations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {recentConversations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No conversations yet.</p>
            ) : (
              recentConversations.map((c) => {
                const lastMsg = c.messages[0];
                const name = c.customer_name ?? c.customer_phone;
                const initials = name
                  .split(' ')
                  .map((w) => w[0])
                  .join('')
                  .toUpperCase()
                  .slice(0, 2);
                return (
                  <Link
                    key={c.id}
                    href={`/inbox/${c.id}`}
                    className="flex items-center gap-3 rounded-md p-1 -m-1 hover:bg-accent"
                  >
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{name}</div>
                      {lastMsg && (
                        <div className="truncate text-xs text-muted-foreground">{lastMsg.content}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(c.last_message_at)}
                    </div>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
