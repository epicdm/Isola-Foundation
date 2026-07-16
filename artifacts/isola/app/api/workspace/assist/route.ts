/**
 * POST /api/workspace/assist — "the agent available to help act on it" on a
 * Workspace queue item detail page. Re-derives the item via
 * getWorkQueueItemDetail() rather than trusting client-supplied context, so
 * the same per-item authorization used by the detail page also gates what
 * the agent is allowed to see and answer about.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getWorkQueueItemDetail } from '@/lib/workspace-item-detail';
import { chatComplete, isAiConfigured, TIER_MODELS } from '@/lib/ai';

export async function POST(req: NextRequest) {
  const session = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isAiConfigured()) {
    return NextResponse.json({ error: 'AI assistant is not configured for this environment' }, { status: 503 });
  }

  const { type, id, question } = (await req.json()) as { type?: string; id?: string; question?: string };
  if (!type || !id || !question?.trim()) {
    return NextResponse.json({ error: 'type, id, and question are required' }, { status: 400 });
  }

  const item = await getWorkQueueItemDetail(session, type, id);
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const system = [
    `You are the Isola workspace assistant, helping ${session.user.name ?? 'a team member'} at ${session.effectiveTenant.business_name} act on one open work-queue item.`,
    'Be concise and concrete — suggest the next action, a draft reply, or a short summary as asked. Only use the context given below; never invent details you were not given.',
    '',
    `Item context: ${item.assistContext}`,
  ].join('\n');

  try {
    const { text } = await chatComplete({
      model: TIER_MODELS.standard,
      system,
      messages: [{ role: 'user', content: question.trim() }],
      maxTokens: 600,
    });
    return NextResponse.json({ answer: text });
  } catch (err) {
    console.error('[workspace assist] chatComplete failed', err);
    return NextResponse.json({ error: 'Assistant is unavailable right now' }, { status: 502 });
  }
}
