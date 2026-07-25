import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Bot, MessageCircle, Phone, UserCheck, Users } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getAiTeam, getHandoffState, getWorkspaceBindingSummary } from '@/lib/workspace/tenant-workspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProvenanceNote, HonestState } from '@/components/workspace/provenance-note';

export const revalidate = 0;

export default async function TeamPage() {
  const session = await getSession();
  if (!session) redirect('/');

  const [team, handoff, connections] = await Promise.all([
    getAiTeam(session),
    getHandoffState(session),
    getWorkspaceBindingSummary(session),
  ]);

  const members = team.data;

  const stats = [
    { label: 'Assistants', value: String(members.length), icon: Bot, sub: 'In this workspace' },
    {
      label: 'Active now',
      value: String(members.filter((m) => m.status === 'active').length),
      icon: UserCheck,
      sub: 'Answering customers',
    },
    {
      label: 'With a person',
      value: String(handoff.data.humanHandlingCount),
      icon: MessageCircle,
      sub: handoff.data.humanHandlingCount === 1 ? 'Conversation handed over' : 'Conversations handed over',
      href: '/inbox',
    },
    {
      label: 'Handovers (7d)',
      value: String(handoff.data.escalationsLast7Days),
      icon: Users,
      sub: 'Assistant asked for help',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Team</h1>
          <p className="text-sm text-muted-foreground">{session.effectiveTenant.business_name}</p>
        </div>
        {handoff.data.ownerTakeoverActive && (
          <Badge variant="destructive" className="mt-1">
            You have taken over from your assistants
          </Badge>
        )}
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

      {members.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <HonestState provenance={team.provenance} icon={Bot} title="No assistants yet" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {members.map((m) => (
            <Card key={m.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-base">{m.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">{m.runtime}</p>
                </div>
                <Badge variant={m.status === 'active' ? 'default' : 'destructive'}>
                  {m.status === 'active' ? 'Active' : 'Paused'}
                </Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {m.greeting && <p className="line-clamp-2 text-sm text-muted-foreground">&ldquo;{m.greeting}&rdquo;</p>}

                <div className="flex flex-col gap-1.5">
                  {m.channels.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No customer channel connected yet.</p>
                  ) : (
                    m.channels.map((c, i) => (
                      <div key={`${c.kind}-${i}`} className="flex items-center gap-2 text-sm">
                        {c.kind === 'whatsapp' ? (
                          <MessageCircle className="size-4 text-muted-foreground" />
                        ) : (
                          <Phone className="size-4 text-muted-foreground" />
                        )}
                        <span className="font-medium">{c.displayNumber ?? 'Number pending'}</span>
                        {c.label && <span className="text-muted-foreground">{c.label}</span>}
                        <Badge variant="outline" className="ml-auto text-[10px]">
                          {c.agentSpecific ? 'Dedicated' : 'Shared'}
                        </Badge>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <ProvenanceNote provenance={team.provenance} />
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/team/${m.id}`}>
                      Open <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!connections.conversationPlatformConnected && (
        <Card>
          <CardContent className="flex flex-col gap-1 py-4">
            <p className="text-sm font-medium">Conversation platform not connected</p>
            <p className="text-sm text-muted-foreground">
              Customer conversations are not being mirrored into this workspace yet. Once your inbox is connected they
              appear under Inbox automatically.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
