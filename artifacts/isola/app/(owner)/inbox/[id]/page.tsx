import { redirect, notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { ArrowLeft, Bot, ExternalLink, User } from 'lucide-react';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { levelSatisfies, resolveWorkspaceAuthz } from '@/lib/workspace/authz';
import { buildChatwootConversationLink } from '@/lib/chatwoot-conversation-link';

export const revalidate = 0;

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/');

  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, tenant_id: session.effectiveTenantId },
    include: { messages: { orderBy: { created_at: 'asc' } }, chatwoot_binding: true },
  });
  if (!conversation) notFound();

  const authz = await resolveWorkspaceAuthz(session);
  const chatwootUrl = buildChatwootConversationLink({
    chatwootConversationId: conversation.chatwoot_conversation_id,
    chatwootBinding: conversation.chatwoot_binding,
    conversationTenantId: conversation.tenant_id,
    canView: levelSatisfies(authz.level, 'manager'),
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/inbox" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Inbox
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">
            {conversation.customer_name ?? conversation.customer_phone}
          </h1>
          <Badge variant={conversation.status === 'open' ? 'default' : 'outline'}>{conversation.status}</Badge>
        </div>
      </div>

      <Card className="max-w-2xl overflow-hidden p-0">
        {/* Messages */}
        <CardContent className="flex max-h-[480px] flex-col gap-3 overflow-y-auto p-5">
          {conversation.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages.</p>
          ) : (
            conversation.messages.map((msg) => (
              <div
                key={msg.id}
                className={cn('flex items-end gap-2', msg.role === 'assistant' ? 'flex-row-reverse' : 'flex-row')}
              >
                <div
                  className={cn(
                    'max-w-[75%] rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed',
                    msg.role === 'assistant'
                      ? 'rounded-br-sm border-primary/20 bg-primary/10'
                      : 'rounded-bl-sm border-border bg-muted'
                  )}
                >
                  {msg.content}
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                    {msg.role === 'assistant' ? (
                      <>
                        <Bot className="size-3" /> AI
                      </>
                    ) : (
                      <User className="size-3" />
                    )}
                    {' · '}
                    {new Date(msg.created_at).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>

        {/* Footer actions */}
        <CardFooter className="gap-3 border-t px-5 py-3">
          <form action={`/api/conversations/${id}`} method="PATCH" className="contents">
            <input type="hidden" name="status" value={conversation.status === 'open' ? 'resolved' : 'open'} />
            <Button type="submit" size="sm" variant={conversation.status === 'open' ? 'secondary' : 'default'}>
              {conversation.status === 'open' ? 'Resolve' : 'Reopen'}
            </Button>
          </form>
          {chatwootUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={chatwootUrl} target="_blank" rel="noopener noreferrer">
                Chatwoot #{conversation.chatwoot_conversation_id} <ExternalLink className="size-3.5" />
              </a>
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
