'use client';

import { useState } from 'react';
import { Bot, Loader2, RotateCcw, Send, User } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type StaffChatState = 'replied' | 'escalated' | 'blocked' | 'degraded' | 'timeout' | 'unavailable' | 'rejected';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  state?: StaffChatState;
  /** Set only on a turn that failed in a way the user can retry. Retrying
   *  resends the SAME turnId, per the correlation contract. */
  retry?: { message: string; turnId: string };
}

/** Copy for every state Port records for this feature. Never a raw provider
 *  error, stack trace or upstream detail — see route.ts, which never sends
 *  one down in the first place. */
const STATE_COPY: Record<Exclude<StaffChatState, 'replied' | 'escalated'>, string> = {
  blocked: "This assistant isn't available for staff chat right now.",
  degraded: 'The assistant hit a snag answering that.',
  timeout: "The assistant didn't respond in time.",
  unavailable: "The assistant isn't configured for chat in this environment right now.",
  rejected: 'The assistant declined this request. Try again in a moment.',
};

const RETRYABLE_STATES: ReadonlySet<StaffChatState> = new Set(['degraded', 'timeout', 'rejected']);

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StaffAgentChat({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [threadId] = useState(newId);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function send(message: string, turnId: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/team/${agentId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, threadId, turnId }),
      });

      if (res.status === 401 || res.status === 403) {
        setTurns((t) => [
          ...t,
          { id: newId(), role: 'system', text: 'Your session no longer has access to this chat.' },
        ]);
        return;
      }
      if (res.status === 404) {
        setTurns((t) => [...t, { id: newId(), role: 'system', text: 'This assistant is not available to chat.' }]);
        return;
      }
      if (!res.ok) {
        setTurns((t) => [
          ...t,
          {
            id: newId(),
            role: 'system',
            text: STATE_COPY.degraded,
            state: 'degraded',
            retry: { message, turnId },
          },
        ]);
        return;
      }

      const data = (await res.json()) as { state: StaffChatState; text: string | null };

      if (data.state === 'replied' || data.state === 'escalated') {
        setTurns((t) => [...t, { id: newId(), role: 'assistant', text: data.text ?? '', state: data.state }]);
        return;
      }

      const copy = STATE_COPY[data.state] ?? STATE_COPY.degraded;
      setTurns((t) => [
        ...t,
        {
          id: newId(),
          role: 'system',
          text: copy,
          state: data.state,
          retry: RETRYABLE_STATES.has(data.state) ? { message, turnId } : undefined,
        },
      ]);
    } catch {
      setTurns((t) => [
        ...t,
        {
          id: newId(),
          role: 'system',
          text: STATE_COPY.degraded,
          state: 'degraded',
          retry: { message, turnId },
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || loading) return;
    setInput('');
    setTurns((t) => [...t, { id: newId(), role: 'user', text: message }]);
    void send(message, newId());
  }

  function retry(turn: ChatTurn) {
    if (!turn.retry || loading) return;
    // Reuses the exact turnId from the failed attempt — the correlation id
    // this retry produces on the wire is identical to the original attempt's.
    void send(turn.retry.message, turn.retry.turnId);
  }

  return (
    <Card className="flex h-[min(70vh,720px)] flex-col">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="size-4 text-primary" /> Chat with {agentName}
        </CardTitle>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
          Live assisted
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden">
        <Alert className="py-2 text-xs text-muted-foreground">
          <AlertDescription className="text-xs">
            No tools are enabled for this conversation. This assistant can advise but cannot act. It does not use a
            specific knowledge scope here. This conversation is not saved — it will be cleared when you leave this
            page.
          </AlertDescription>
        </Alert>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Send a message to start this conversation.
            </p>
          )}
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn('flex items-start gap-2', turn.role === 'user' ? 'flex-row-reverse text-right' : '')}
            >
              {turn.role !== 'system' && (
                <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
                  {turn.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
                </div>
              )}
              <div
                className={cn(
                  'max-w-[80%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap',
                  turn.role === 'user' && 'bg-primary text-primary-foreground',
                  turn.role === 'assistant' && 'bg-muted/60',
                  turn.role === 'system' && 'mx-auto w-full max-w-full bg-transparent text-center text-xs text-muted-foreground',
                )}
              >
                {turn.text}
                {turn.state === 'escalated' && (
                  <Badge variant="secondary" className="ml-2 align-middle text-[10px] uppercase">
                    Escalated
                  </Badge>
                )}
                {turn.retry && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mt-1 h-6 gap-1 text-xs"
                    onClick={() => retry(turn)}
                    disabled={loading}
                  >
                    <RotateCcw className="size-3" /> Retry
                  </Button>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Waiting for a reply…
            </div>
          )}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-2 border-t pt-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${agentName}…`}
            className="min-h-[60px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
          />
          <Button type="submit" size="sm" disabled={loading || !input.trim()} className="self-end">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
