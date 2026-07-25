import { ArrowRight, Bot, Inbox, MessageSquareText, UserCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KPIS } from '../../_lib/mock-data';

const CHIPS = [
  { label: 'Open conversations', value: KPIS.openConversations, icon: Inbox },
  { label: 'Awaiting human', value: KPIS.awaitingHuman, icon: UserCheck },
  { label: 'AI-handled today', value: KPIS.aiHandledToday, icon: Bot },
];

export default function ConversationsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MessageSquareText className="size-7" />
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Your team&apos;s conversations live in Chatwoot</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Chatwoot is the operator workspace for every conversation across every channel — AI-handled and
          human-handled alike. Isola doesn&apos;t run a second inbox alongside it; this page is a governed entry
          point, not a place to read or send messages.
        </p>
      </div>

      <Card className="w-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Today at a glance</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          {CHIPS.map((chip) => (
            <div key={chip.label} className="rounded-lg border p-3">
              <chip.icon className="mb-1.5 size-4 text-primary" />
              <div className="text-xl font-bold tracking-tight">{chip.value}</div>
              <div className="text-xs text-muted-foreground">{chip.label}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Button asChild size="lg">
        <a href="/chatwoot">
          Open Chatwoot Workspace <ArrowRight className="size-4" />
        </a>
      </Button>

      <p className="text-xs text-muted-foreground">
        Isola does not duplicate Chatwoot&apos;s inbox — this page is a governed entry point only.
      </p>
    </div>
  );
}
