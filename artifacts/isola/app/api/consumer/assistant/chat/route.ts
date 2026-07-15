/**
 * POST /api/consumer/assistant/chat — the P4 companion-agent chat endpoint.
 *
 * Session-gated ONLY (getConsumerSession) — never accepts an account id
 * from the request body. Delegates to lib/consumer-agent.ts, which is the
 * only place tool calls happen; this route just wires the HTTP contract.
 *
 * Body: { message: string, history?: { role: 'user'|'assistant', content: string }[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { isAiConfigured } from '@/lib/ai';
import { runConsumerAgentTurn, type ConsumerChatMessage } from '@/lib/consumer-agent';

export async function POST(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isAiConfigured()) {
    return NextResponse.json({ error: 'Assistant is not configured (ANTHROPIC_API_KEY)' }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  if (message.length > 2000) {
    return NextResponse.json({ error: 'message is too long' }, { status: 400 });
  }

  const rawHistory = Array.isArray(body?.history) ? body.history : [];
  const history: ConsumerChatMessage[] = rawHistory
    .filter(
      (m: any) =>
        m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
    )
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  try {
    const result = await runConsumerAgentTurn(account, history, message);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[consumer/assistant/chat] error:', e?.message ?? e);
    return NextResponse.json({ error: 'Assistant is temporarily unavailable' }, { status: 502 });
  }
}
