import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, BookOpen, Clock, MessageCircle, MessageSquareText, Phone, Settings2, Wrench } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getAgentDetail, getAgentTools, getAgentRuntimePanel } from '@/lib/workspace/tenant-workspace';
import { WorkspaceAccessDenied } from '@/components/workspace/access-denied';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProvenanceNote, HonestState } from '@/components/workspace/provenance-note';

export const revalidate = 0;

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) redirect('/');

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />;

  const { agentId } = await params;
  const [panel, runtimePanel] = await Promise.all([
    getAgentDetail(session, agentId, { includeConfiguration: guard.authz.canViewConfiguration }),
    getAgentRuntimePanel(session, agentId),
  ]);
  if (!panel) notFound();

  const agent = panel.data;
  const tools = getAgentTools();
  const runtime = runtimePanel?.data;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Button asChild size="sm" variant="ghost" className="-ml-2 w-fit text-muted-foreground">
            <Link href="/team">
              <ArrowLeft className="size-3.5" /> AI Team
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="text-sm text-muted-foreground">{agent.runtime}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={agent.status === 'active' ? 'default' : 'destructive'}>
            {agent.status === 'active' ? 'Active' : 'Paused'}
          </Badge>
          <Button asChild size="sm" variant="outline">
            <Link href={`/team/${agentId}/chat`}>
              <MessageSquareText className="size-3.5" /> Chat
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/agent">
              <Settings2 className="size-3.5" /> Settings
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: 'Conversations',
            value: String(agent.conversationCount),
            sub: agent.countsAreWorkspaceWide ? 'Across this workspace' : 'All time',
          },
          {
            label: 'Open now',
            value: String(agent.openConversationCount),
            sub: agent.countsAreWorkspaceWide ? 'Across this workspace' : 'Awaiting reply',
          },
          {
            label: 'With a person',
            value: String(agent.humanHandlingCount),
            sub: agent.countsAreWorkspaceWide ? 'Across this workspace' : 'Handed over',
          },
          { label: 'Channels', value: String(agent.channels.length), sub: 'Connected' },
        ].map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
              <p className="text-xs text-muted-foreground">{s.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">What this assistant does</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {agent.responsibilities.greeting && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Opening message</p>
                <p className="text-sm">&ldquo;{agent.responsibilities.greeting}&rdquo;</p>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Business context it answers from
              </p>
              {agent.responsibilities.businessInfo ? (
                <p className="whitespace-pre-wrap text-sm">{agent.responsibilities.businessInfo}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No business description has been added yet. Add one in Settings so the assistant can answer questions
                  about your business.
                </p>
              )}
            </div>

            {agent.responsibilities.afterHours && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outside hours</p>
                <p className="inline-flex items-center gap-2 text-sm">
                  <Clock className="size-4 text-muted-foreground" />
                  {agent.responsibilities.afterHours.start ?? '—'} to {agent.responsibilities.afterHours.end ?? '—'} (
                  {agent.responsibilities.afterHours.timezone})
                </p>
                {agent.responsibilities.awayMessage && (
                  <p className="text-sm text-muted-foreground">
                    Replies: &ldquo;{agent.responsibilities.awayMessage}&rdquo;
                  </p>
                )}
              </div>
            )}

            <ProvenanceNote provenance={panel.provenance} className="pt-1" />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Channels</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {agent.channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No customer channel connected yet.</p>
              ) : (
                agent.channels.map((c, i) => (
                  <div key={`${c.kind}-${i}`} className="flex items-center gap-2 text-sm">
                    {c.kind === 'whatsapp' ? (
                      <MessageCircle className="size-4 text-muted-foreground" />
                    ) : (
                      <Phone className="size-4 text-muted-foreground" />
                    )}
                    <span className="font-medium">{c.displayNumber ?? 'Number pending'}</span>
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      {c.kind === 'whatsapp' ? 'WhatsApp' : 'Voice'}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Knowledge</CardTitle>
              <BookOpen className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {agent.responsibilities.knowledgeSummary ? (
                <>
                  <p className="line-clamp-6 whitespace-pre-wrap text-sm text-muted-foreground">
                    {agent.responsibilities.knowledgeSummary}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {agent.responsibilities.knowledgeCharacters.toLocaleString()} characters of knowledge
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No knowledge has been added yet. Add FAQs, policies or product details in Settings.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">What this assistant can do</CardTitle>
          <Wrench className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="p-0">
          {runtimePanel && runtimePanel.provenance.availability === 'live' && runtime?.toolsVerified ? (
            <>
              <div className="border-b">
                {runtime.tools.length === 0 ? (
                  <p className="px-6 py-4 text-sm text-muted-foreground">
                    This assistant currently has no tools enabled. It answers from its knowledge only.
                  </p>
                ) : (
                  runtime.tools.map((t) => (
                    <div key={t.name} className="flex items-center gap-3 border-b px-6 py-3 last:border-b-0">
                      <div className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium truncate">{t.displayName}</span>
                        {t.description && (
                          <span className="text-xs text-muted-foreground truncate">{t.description}</span>
                        )}
                      </div>
                      {t.category && (
                        <Badge variant="secondary" className="ml-auto text-[10px] uppercase">
                          {t.category}
                        </Badge>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="px-6 py-3">
                <ProvenanceNote provenance={runtimePanel.provenance} />
              </div>
            </>
          ) : (
            <>
              <div className="px-6">
                <HonestState
                  provenance={runtimePanel?.provenance ?? tools.provenance}
                  icon={Wrench}
                  title="Live tool list unavailable"
                />
              </div>
              <div className="border-t">
                <p className="px-6 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tools this workspace allows
                </p>
                {tools.data.map((t) => (
                  <div key={t.name} className="flex items-center gap-3 border-b px-6 py-3 last:border-b-0">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium truncate">{t.description}</span>
                      <span className="text-xs text-muted-foreground truncate">{t.name}</span>
                    </div>
                    <Badge variant="secondary" className="ml-auto text-[10px] uppercase">
                      {t.tier}
                    </Badge>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {runtimePanel && runtime?.profile?.roleDescription && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Role, as configured in the assistant runtime</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">{runtime.profile.roleDescription}</p>
            {runtime.profile.bio && <p className="text-sm text-muted-foreground">{runtime.profile.bio}</p>}
            {runtime.profile.runtimeState && (
              <p className="text-sm text-muted-foreground">Runtime status: {runtime.profile.runtimeState}</p>
            )}
            <ProvenanceNote provenance={runtimePanel.provenance} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
