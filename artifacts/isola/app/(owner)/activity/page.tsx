import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Activity, ArrowRight, MessageCircle, TrendingUp, UserCheck } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getActivitySummary, getConversationOverview, getHandoffState } from '@/lib/workspace/tenant-workspace';
import { relativeTime } from '@/lib/workspace-queue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProvenanceNote, HonestState } from '@/components/workspace/provenance-note';

export const revalidate = 0;

export default async function ActivityPage() {
  const session = await getSession();
  if (!session) redirect('/');

  const [activityPanel, conversationsPanel, handoffPanel] = await Promise.all([
    getActivitySummary(session),
    getConversationOverview(session, 10),
    getHandoffState(session),
  ]);

  const a = activityPanel.data;
  const handoff = handoffPanel.data;

  const stats = [
    { label: 'Conversations', value: String(a.conversationsTotal), icon: MessageCircle, sub: 'All time' },
    { label: 'Open', value: String(a.conversationsOpen), icon: Activity, sub: 'Awaiting reply', href: '/inbox' },
    { label: 'New (7 days)', value: String(a.conversationsLast7Days), icon: TrendingUp, sub: 'Started this week' },
    {
      label: 'Handovers (7d)',
      value: String(handoff.escalationsLast7Days),
      icon: UserCheck,
      sub: 'Assistant asked for help',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity &amp; Reports</h1>
        <p className="text-sm text-muted-foreground">
          What your assistants and your team have been doing, with the source of every number.
        </p>
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

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {a.recent.length === 0 ? (
              <HonestState provenance={activityPanel.provenance} icon={Activity} title="Nothing recorded yet" />
            ) : (
              <div>
                {a.recent.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 border-b px-6 py-3 last:border-b-0">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm truncate">{e.label}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {e.actor}
                        {e.entity ? ` · ${e.entity}` : ''}
                      </span>
                    </div>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {relativeTime(new Date(e.at))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
          {a.recent.length > 0 && (
            <div className="px-6 pb-4">
              <ProvenanceNote provenance={activityPanel.provenance} />
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Human handoff</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Being handled by a person</span>
                <Badge variant={handoff.humanHandlingCount > 0 ? 'default' : 'outline'}>
                  {handoff.humanHandlingCount}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Owner takeover</span>
                <Badge variant={handoff.ownerTakeoverActive ? 'destructive' : 'outline'}>
                  {handoff.ownerTakeoverActive ? 'On' : 'Off'}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last handover</span>
                <span>
                  {handoff.mostRecentEscalationAt ? relativeTime(new Date(handoff.mostRecentEscalationAt)) : 'None yet'}
                </span>
              </div>
              <ProvenanceNote provenance={handoffPanel.provenance} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Usage this month</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {a.usageThisMonth ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Voice minutes</span>
                    <span className="font-medium">{a.usageThisMonth.minutesUsed.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Messages (7 days)</span>
                    <span className="font-medium">{a.messagesLast7Days}</span>
                  </div>
                  <Button asChild size="sm" variant="ghost" className="w-fit px-0 text-primary">
                    <Link href="/plan">
                      Plan &amp; usage <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No metered usage recorded for this month yet. Voice minutes and assistant usage appear here once
                  customers start using your service.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Latest conversations</CardTitle>
          <Button asChild size="sm" variant="ghost">
            <Link href="/inbox">
              Open Inbox <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {conversationsPanel.data.length === 0 ? (
            <HonestState provenance={conversationsPanel.provenance} icon={MessageCircle} />
          ) : (
            <div>
              {conversationsPanel.data.map((c) => (
                <Link
                  key={c.id}
                  href={`/inbox/${c.id}`}
                  className="flex items-center gap-3 border-b px-6 py-3 last:border-b-0 hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium truncate">{c.customerName ?? c.customerPhone}</span>
                    {c.preview && <span className="text-xs text-muted-foreground truncate">{c.preview}</span>}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {c.humanHandling && (
                      <Badge variant="secondary" className="text-[10px]">
                        With a person
                      </Badge>
                    )}
                    <Badge variant={c.status === 'open' ? 'default' : 'outline'}>{c.status}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {c.lastMessageAt ? relativeTime(new Date(c.lastMessageAt)) : '—'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
        {conversationsPanel.data.length > 0 && (
          <div className="px-6 pb-4">
            <ProvenanceNote provenance={conversationsPanel.provenance} />
          </div>
        )}
      </Card>
    </div>
  );
}
