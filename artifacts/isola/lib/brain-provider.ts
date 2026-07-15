/**
 * Brain-provider abstraction.
 *
 * Per-tenant choice of reply runtime:
 *   native  (default) → lib/ai.ts chatComplete() — Anthropic Claude, unchanged.
 *   flowise           → external self-hosted Flowise chatflow, called over HTTP.
 *   hermes            → external CC-owned Hermes agent, called over HTTP.
 *
 * Contract: generateReply() ALWAYS resolves — it never throws. Any Flowise
 * or Hermes failure (timeout, non-2xx, empty text, network error) falls back
 * to the native runtime transparently so callers (the agent-bot route, the
 * direct WhatsApp webhook handler) do not need to know which provider
 * actually answered.
 *
 * This module wraps lib/ai.ts; it does not modify it. lib/engines.ts is
 * untouched — Flowise/Hermes are not "setup checklist" engines, they're a
 * per-tenant reply runtime choice.
 *
 * HERMES PER-NUMBER GATE: hermes is only ever attempted for phone_number_ids
 * in HERMES_ALLOWED_PHONE_NUMBER_IDS below. This is a deliberate second gate
 * on top of the agent's brain_provider column — the same shared-WABA app-level
 * webhook risk documented for the EMA sales number (see memory: "the 3742
 * trap") means a tenant-scoped column alone is not defense enough; a
 * hardcoded allowlist keyed on the Meta-issued phone_number_id ensures
 * flipping one tenant to hermes can never affect another number, even by
 * misconfiguration.
 */

import { chatComplete, TIER_MODELS } from './ai';

const FLOWISE_TIMEOUT_MS = 20_000;
// Hermes agent replies in ~10-45s; 50s gives headroom before falling back to
// native so a slow-but-healthy reply is never mistaken for a dead endpoint.
const HERMES_TIMEOUT_MS = 50_000;

/** Generalized Hermes endpoint (non-secret) — ONE path for every hermes
 * number. The endpoint itself resolves which account/persona to use from
 * the `phone_number_id` in the request body (per CC: 975632242309171 +
 * 294957850360835 → epic-business, 1023804347491554 → ema-customer).
 * Going live for a new number is just adding its phone_number_id to
 * HERMES_ALLOWED_PHONE_NUMBER_IDS below plus flipping that tenant's
 * Agent.brain_provider — never a separate URL configuration step, and
 * still gated by the allowlist regardless of this default. Superseded the
 * former EMA-specific `/api/internal/ema/invoke` path (2026-07-13) — every
 * hermes number, including EMA, now calls this same URL. */
const DEFAULT_HERMES_AGENT_URL = 'https://bff.epic.dm/api/internal/agent/invoke';

/** Only these Meta phone_number_ids may ever be routed to Hermes. */
export const HERMES_ALLOWED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  '1023804347491554', // EMA sales / onboarding number, +17678180001
  '975632242309171',  // EPIC main, +17678183742
  '294957850360835',  // EPIC FB-linked, +17672851568 — inbound-reply only, see epic-seed-data.ts
]);

export interface BrainReplyResult {
  text: string;
  tokensUsed: number;
  model: string;
  /** Which runtime actually produced the reply — 'native' may be a fallback. */
  provider: 'native' | 'flowise' | 'hermes';
}

export interface BrainAgent {
  intelligence_tier: string;
  brain_provider: string;       // 'native' | 'flowise' | 'hermes'
  flowise_flow_id: string | null;
}

/**
 * Generate a reply for one incoming message, honoring the agent's configured
 * brain_provider with strict fallback-to-native on any Flowise/Hermes failure.
 */
export async function generateReply(params: {
  agent: BrainAgent;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Stable per-conversation key so Flowise/Hermes memory keeps context. */
  sessionId: string;
  /** Meta phone_number_id this reply is being generated for — required for the hermes per-number gate. */
  phoneNumberId: string;
  /** E.164 sender phone, forwarded verbatim to Hermes. */
  senderPhone: string;
}): Promise<BrainReplyResult> {
  const { agent, system, messages, sessionId, phoneNumberId, senderPhone } = params;
  const model = TIER_MODELS[agent.intelligence_tier] ?? TIER_MODELS['standard'];

  if (agent.brain_provider === 'flowise' && agent.flowise_flow_id) {
    const flowiseResult = await tryFlowise({
      flowId: agent.flowise_flow_id,
      messages,
      sessionId,
    });
    if (flowiseResult) {
      return { ...flowiseResult, model: `flowise:${agent.flowise_flow_id}` };
    }
    console.warn('[brain-provider] Flowise failed — falling back to native for this reply');
  }

  if (agent.brain_provider === 'hermes') {
    if (!HERMES_ALLOWED_PHONE_NUMBER_IDS.has(phoneNumberId)) {
      console.warn(
        `[brain-provider] brain_provider=hermes but phone_number_id ${phoneNumberId} is not on the hermes allowlist — falling back to native`,
      );
    } else {
      const hermesResult = await tryHermes({ messages, sessionId, phoneNumberId, senderPhone });
      if (hermesResult) {
        return { ...hermesResult, model: 'hermes' };
      }
      console.warn('[brain-provider] Hermes failed — falling back to native for this reply');
    }
  }

  const result = await chatComplete({ model, system, messages, maxTokens: 4096 });
  return {
    text: result.text,
    tokensUsed: result.inputTokens + result.outputTokens,
    model,
    provider: 'native',
  };
}

// ── Flowise implementation ───────────────────────────────────────────────────

/**
 * Calls the self-hosted Flowise prediction endpoint. Returns null on any
 * failure (timeout, non-2xx, network error, empty/missing text) so the
 * caller can fall back to native — never throws.
 *
 * Verified response shape (live probe against chatflow SOCKET-TEST-fable):
 *   { text, question, chatId, chatMessageId, isStreamValid, sessionId, memoryType }
 * Only `text` is used; the rest is Flowise's own bookkeeping.
 */
async function tryFlowise(params: {
  flowId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
}): Promise<{ text: string; tokensUsed: number; provider: 'flowise' } | null> {
  const baseUrl = process.env.FLOWISE_URL;
  const apiKey = process.env.FLOWISE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.warn('[brain-provider] FLOWISE_URL/FLOWISE_API_KEY not configured — cannot use flowise provider');
    return null;
  }

  // Flowise's /prediction endpoint takes a single "question" plus its own
  // sessionId-keyed memory — it does not accept a full chat history array.
  const lastUserMessage = [...params.messages].reverse().find((m) => m.role === 'user');
  const question = lastUserMessage?.content ?? '';
  if (!question) return null;

  try {
    const res = await fetch(`${baseUrl}/api/v1/prediction/${params.flowId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        question,
        overrideConfig: { sessionId: params.sessionId },
      }),
      signal: AbortSignal.timeout(FLOWISE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[brain-provider] Flowise prediction failed (${res.status}): ${errText}`);
      return null;
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) {
      console.error('[brain-provider] Flowise response had no usable text field');
      return null;
    }

    // Flowise doesn't report token usage — cost is $0 to our meter for this reply.
    return { text, tokensUsed: 0, provider: 'flowise' };
  } catch (err: any) {
    console.error('[brain-provider] Flowise request error:', err?.message ?? err);
    return null;
  }
}

// ── Hermes implementation ─────────────────────────────────────────────────────

/**
 * Calls the CC-owned, GENERALIZED Hermes agent endpoint — one path for
 * every hermes number (EMA, EPIC main, EPIC FB-linked, and any future
 * addition). Returns null on any failure (timeout, non-2xx, network error,
 * empty/missing reply_text) so the caller falls back to native — never
 * throws.
 *
 * Contract (Foundation → Hermes):
 *   POST {HERMES_AGENT_URL || DEFAULT_HERMES_AGENT_URL}  (.../agent/invoke)
 *   headers: { 'x-internal-secret': BFF_INTERNAL_SECRET } — server-to-server
 *     auth, reusing the same App Secret already set for the mirror-account/
 *     top-up BFF Lite integration. Missing/invalid secret → 401 → fallback
 *     to native (never throws).
 *   body: { phone_number_id, sender_phone, message, session_id } — Hermes
 *     resolves the account/persona (epic-business vs ema-customer, etc.)
 *     from phone_number_id; Foundation does not need to know that mapping.
 *   expects: { reply_text: string, actions?: unknown }
 * `actions` is accepted but currently ignored — Hermes is a pure text brain
 * for this socket; Foundation remains the sole WhatsApp I/O surface.
 */
async function tryHermes(params: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
  phoneNumberId: string;
  senderPhone: string;
}): Promise<{ text: string; tokensUsed: number; provider: 'hermes' } | null> {
  const baseUrl = process.env.HERMES_AGENT_URL || DEFAULT_HERMES_AGENT_URL;
  const internalSecret = process.env.BFF_INTERNAL_SECRET;
  if (!internalSecret) {
    console.warn('[brain-provider] BFF_INTERNAL_SECRET not configured — cannot use hermes provider');
    return null;
  }

  const lastUserMessage = [...params.messages].reverse().find((m) => m.role === 'user');
  const message = lastUserMessage?.content ?? '';
  if (!message) return null;

  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': internalSecret,
      },
      body: JSON.stringify({
        sender_phone: params.senderPhone,
        message,
        session_id: params.sessionId,
        phone_number_id: params.phoneNumberId,
      }),
      signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[brain-provider] Hermes call failed (${res.status}): ${errText}`);
      return null;
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.reply_text === 'string' ? data.reply_text.trim() : '';
    if (!text) {
      console.error('[brain-provider] Hermes response had no usable reply_text field');
      return null;
    }

    // Hermes doesn't report token usage — cost is $0 to our meter for this reply.
    return { text, tokensUsed: 0, provider: 'hermes' };
  } catch (err: any) {
    console.error('[brain-provider] Hermes request error:', err?.message ?? err);
    return null;
  }
}
