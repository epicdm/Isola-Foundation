export interface ChatwootContextHint {
  readonly accountIdHint: number;
  readonly inboxIdHint: number;
  readonly conversationDisplayIdHint: number;
}

export type ChatwootContextResult =
  | { ok: true; hint: ChatwootContextHint }
  | { ok: false; reason: string };

export const CHATWOOT_FETCH_INFO_REQUEST = 'chatwoot-dashboard-app:fetch-info';

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse only the three Chatwoot locators the server can independently verify. */
export function parseChatwootContext(raw: unknown): ChatwootContextResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }

  if (!record(parsed) || parsed.event !== 'appContext') {
    return { ok: false, reason: 'wrong-event' };
  }
  const data = parsed.data;
  const conversation = record(data) ? data.conversation : null;
  if (!record(conversation)) return { ok: false, reason: 'missing-conversation' };

  const accountIdHint = positiveInt(conversation.account_id);
  const inboxIdHint = positiveInt(conversation.inbox_id);
  const conversationDisplayIdHint = positiveInt(conversation.id);
  if (!accountIdHint || !inboxIdHint || !conversationDisplayIdHint) {
    return { ok: false, reason: 'invalid-identifiers' };
  }

  return {
    ok: true,
    hint: { accountIdHint, inboxIdHint, conversationDisplayIdHint },
  };
}
