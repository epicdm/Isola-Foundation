import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Bot, BookOpen, Clock, ExternalLink, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AGENTS } from '../../../_lib/mock-data';

const TIER_LABEL: Record<string, string> = {
  standard: 'Standard — Claude Haiku',
  advanced: 'Advanced — Claude Sonnet',
  expert: 'Expert — Claude Opus',
};

export function generateStaticParams() {
  return AGENTS.map((a) => ({ agentId: a.id }));
}

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) notFound();

  return (
    <div className="max-w-2xl">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link href="/preview/control-plane/ai-team">
          <ArrowLeft className="size-3.5" /> Back to AI Team
        </Link>
      </Button>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{agent.name}</h1>
            <Badge variant={agent.status === 'Live' ? 'default' : agent.status === 'Assisted' ? 'secondary' : 'outline'}>
              {agent.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{agent.role} (mock — read only)</p>
        </div>
        <Button variant="outline" size="sm" disabled>
          <ExternalLink className="size-3.5" /> View in Clawith
        </Button>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4 text-primary" /> Identity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs font-semibold text-muted-foreground">Greeting</div>
              <p>{agent.greeting}</p>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted-foreground">Assigned channels</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {agent.channels.length ? (
                  agent.channels.map((c) => <Badge key={c} variant="outline">{c}</Badge>)
                ) : (
                  <span className="text-muted-foreground">None yet</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="size-4 text-primary" /> Knowledge
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs font-semibold text-muted-foreground">Business info</div>
              <p className="text-muted-foreground">{agent.business_info}</p>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted-foreground">Knowledge base</div>
              <p className="text-muted-foreground">{agent.knowledge_text}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4 text-primary" /> Intelligence tier
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{TIER_LABEL[agent.intelligence_tier]}</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4 text-primary" /> After-hours &amp; timezone
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {agent.after_hours_start && agent.after_hours_end
              ? `Silent from ${agent.after_hours_start} to ${agent.after_hours_end}`
              : 'Replies 24/7'}
            {' · '}
            {agent.timezone}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
