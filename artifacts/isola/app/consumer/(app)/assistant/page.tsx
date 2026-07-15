'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Sparkles, ArrowUpCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ChatAction {
  type: 'navigate_topup';
  amount: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: ChatAction[];
}

const SUGGESTIONS = [
  "What's my balance?",
  'How do I set up Acrobits?',
  'How do I call Dominica?',
  'Turn on call forwarding',
];

export default function ConsumerAssistantPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        "Hi! I'm the EMA concierge. I can check your balance, help you set up your softphone, top up your wallet, or adjust call forwarding. What do you need?",
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/consumer/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: nextMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Assistant is unavailable right now.');
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply, actions: data.actions }]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to reach the assistant.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" />
          EMA Concierge
        </h1>
        <p className="text-sm text-muted-foreground">Ask about your balance, softphone, or line settings.</p>
      </div>

      <Card className="flex flex-1 flex-col overflow-hidden">
        <CardContent className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" ref={scrollRef}>
          {messages.map((m, i) => (
            <div key={i} className={cn('flex flex-col gap-2', m.role === 'user' ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm',
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                {m.content}
              </div>
              {m.actions?.map((action, j) =>
                action.type === 'navigate_topup' ? (
                  <Button
                    key={j}
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/consumer/wallet?amount=${action.amount}`)}
                  >
                    <ArrowUpCircle className="size-4" />
                    Top up EC${action.amount.toFixed(2)}
                  </Button>
                ) : null,
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-start">
              <div className="rounded-2xl bg-muted px-3.5 py-2 text-sm text-muted-foreground">Typing…</div>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </CardContent>

        {messages.length <= 1 && (
          <div className="flex flex-wrap gap-2 border-t px-4 py-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2 border-t p-3"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask me anything about your EMA line…"
            rows={1}
            className="min-h-9 flex-1 resize-none"
          />
          <Button type="submit" size="icon" disabled={loading || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </Card>
    </div>
  );
}
