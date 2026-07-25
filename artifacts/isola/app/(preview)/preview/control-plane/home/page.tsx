import Link from 'next/link';
import { Bot, MessageSquare, PhoneMissed, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UsageChart, type UsagePoint } from '@/components/usage-chart';
import { AGENTS, ACTIVITY, KPIS, TENANT } from '../../_lib/mock-data';

const CHART_DATA: UsagePoint[] = [
  { month: 'Feb', tokens: 12000, minutes: 34 },
  { month: 'Mar', tokens: 15400, minutes: 41 },
  { month: 'Apr', tokens: 14100, minutes: 38 },
  { month: 'May', tokens: 18900, minutes: 52 },
  { month: 'Jun', tokens: 21200, minutes: 47 },
  { month: 'Jul', tokens: 19800, minutes: 55 },
];

const STATS = [
  { label: 'Open conversations', value: KPIS.openConversations.toString(), sub: 'View conversations', href: '/preview/control-plane/conversations', icon: MessageSquare },
  { label: 'Missed calls today', value: KPIS.missedCallsToday.toString(), sub: 'View channels', href: '/preview/control-plane/channels', icon: PhoneMissed },
  { label: 'Wallet balance', value: `EC$${KPIS.walletBalance.toFixed(2)}`, sub: 'Top up', href: '/preview/control-plane/billing', icon: Wallet },
  { label: 'Plan usage', value: `${KPIS.planUsagePct}%`, sub: 'View billing', href: '/preview/control-plane/billing', icon: Bot },
];

export default function ControlPlaneHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
        <p className="text-sm text-muted-foreground">{TENANT.name} · business overview (mock)</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </CardTitle>
              <s.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
              <Link href={s.href} className="text-xs text-primary hover:underline">
                {s.sub} &rarr;
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <UsageChart data={CHART_DATA} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">AI Team snapshot</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {AGENTS.map((a) => (
              <div key={a.id} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">{a.role}</div>
                </div>
                <Badge variant={a.status === 'Live' ? 'default' : a.status === 'Assisted' ? 'secondary' : 'outline'}>
                  {a.status}
                </Badge>
              </div>
            ))}
            <Link href="/preview/control-plane/ai-team" className="text-xs text-primary hover:underline">
              Manage AI Team &rarr;
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {ACTIVITY.slice(0, 4).map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3">
                <span className="text-sm">{item.text}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.ts}</span>
              </div>
            ))}
            <Link href="/preview/control-plane/activity" className="text-xs text-primary hover:underline">
              View all activity &rarr;
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
