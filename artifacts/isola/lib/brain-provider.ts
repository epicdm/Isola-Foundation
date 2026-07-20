/**
 * Brain-provider abstraction.
 *
 * Per-tenant choice of reply runtime:
 *   native  (default) → lib/ai.ts chatComplete() — Anthropic Claude, unchanged.
 *   flowise           → external self-hosted Flowise chatflow, called over HTTP.
 *   hermes            → external CC-owned Hermes agent, routed through bff-v2, called over HTTP.
 *   clawith           → Clawith, called DIRECTLY (no bff-v2 hop). The contained v1.11.0
 *                       tryIsolaBridge() is the DEFAULT for every clawith number
 *                       (2026-07-18 legacy retirement). tryClawithLegacy() (original
 *                       runtime.epic.dm/api/internal/dispatch contract) is retained ONLY as an
 *                       env-gated rollback (ISOLA_LEGACY_CLAWITH_FALLBACK=1) and is never
 *                       reached by default. ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS documents the
 *                       always-on contained floor (allowlisted numbers can never regress to legacy).
 *
 * Contract: generateReply() ALWAYS resolves — it never throws. Any Flowise,
 * Hermes, or Clawith failure (timeout, non-2xx, empty text, network error)
 * falls back to the native runtime transparently so callers (the agent-bot
 * route, the direct WhatsApp webhook handler) do not need to know which
 * provider actually answered.
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
import { decryptSecret } from './tenant-secrets';
import { prisma } from './prisma';

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

/**
 * The always-on floor of Meta phone_number_ids routed to the new v1.11.0
 * Isola bridge (tryIsolaBridge). Every other clawith-provider number falls
 * through to tryClawithLegacy (the original runtime.epic.dm/api/internal/
 * dispatch contract) unchanged — this is the per-number cutover gate so
 * flipping the bridge live for one number can never affect another tenant's
 * already-working clawith integration (mirrors HERMES_ALLOWED_PHONE_NUMBER_IDS
 * above, same rationale).
 */
const _BRIDGE_ALLOWED_HARDCODED: readonly string[] = [
  '1023804347491554', // EMA sales / onboarding number, +17678180001 — v1.11.0 cutover
  '278390858690809',  // EPIC 295-6737, +17672956737 — v1.11.0 contained cutover (2026-07-18)
];

/**
 * Additional Meta phone_number_ids may be added at runtime via the
 * ISOLA_BRIDGE_ALLOWED_PNIDS env var (comma-separated) so a future number
 * goes live on the contained bridge with only a Replit Secret + restart —
 * no code deploy. The hardcoded list above is the always-on floor; env
 * entries are additive and never remove a hardcoded one.
 */
export const ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  ..._BRIDGE_ALLOWED_HARDCODED,
  ...(process.env.ISOLA_BRIDGE_ALLOWED_PNIDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
]);

export interface BrainReplyResult {
  text: string;
  tokensUsed: number;
  model: string;
  /** Which runtime actually produced the reply — 'native' may be a fallback. */
  provider: 'native' | 'flowise' | 'hermes' | 'clawith';
  /** True when the brain flagged this conversation for human review. Only
   * Clawith emits this today; threaded through generically so callers
   * (the agent-bot route) can surface it regardless of which provider set it. */
  needsHandoff?: boolean;
  /** Opaque action payload some providers may return alongside the reply.
   * Not acted on by Foundation today — this socket remains text-only I/O. */
  actions?: unknown;
}

export interface BrainAgent {
  intelligence_tier: string;
  brain_provider: string;       // 'native' | 'flowise' | 'hermes' | 'clawith'
  flowise_flow_id: string | null;
}

/** Tenant's Clawith identity, resolved from the ClawithBinding table. */
export interface ClawithBindingInput {
  clawith_agent_id: string;
  paperclip_agent_id: string;
  paperclip_company_id: string;
}

/** Tenant's Odoo connection, resolved from the OdooBinding table.
 *  When present, passed to Clawith so it uses the tenant's own Odoo
 *  instead of its hardcoded sandbox credentials. */
export interface OdooBindingInput {
  url: string;
  db: string;
  login: string | null;
  /** Plaintext API key — caller must decrypt before passing here. */
  password: string;
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
  /** E.164 sender phone, forwarded verbatim to Hermes/Clawith. */
  senderPhone: string;
  /** Tenant's Clawith identity — required for brain_provider='clawith'; null/absent falls back to native. */
  clawithBinding?: ClawithBindingInput | null;
  /** Tenant's Odoo connection — when present, Clawith uses the tenant's own Odoo instead of its sandbox. */
  odooBinding?: OdooBindingInput | null;
}): Promise<BrainReplyResult> {
  const { agent, system, messages, sessionId, phoneNumberId, senderPhone, clawithBinding, odooBinding } = params;
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

  if (agent.brain_provider === 'clawith') {
    if (!clawithBinding) {
      console.warn(
        '[brain-provider] brain_provider=clawith but no ClawithBinding for this tenant — falling back to native',
      );
    } else if (
      process.env.ISOLA_LEGACY_CLAWITH_FALLBACK === '1' &&
      !ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS.has(phoneNumberId)
    ) {
      // Rollback-only path, OFF by default (legacy runtime.epic.dm dispatch retired
      // 2026-07-18). Set ISOLA_LEGACY_CLAWITH_FALLBACK=1 to temporarily restore the legacy
      // path for a NON-allowlisted number during an incident. Allowlisted numbers (the
      // contained floor) never take this path and can never regress to legacy.
      const clawithResult = await tryClawithLegacy({
        agentId: clawithBinding.clawith_agent_id,
        paperclipAgentId: clawithBinding.paperclip_agent_id,
        paperclipCompanyId: clawithBinding.paperclip_company_id,
        messages,
        sessionId,
        callerPhone: senderPhone,
        odooBinding: odooBinding ?? null,
      });
      if (clawithResult) {
        return { ...clawithResult, model: 'clawith' };
      }
      console.warn('[brain-provider] Clawith (legacy rollback) failed — falling back to native for this reply');
    } else {
      // DEFAULT: the contained v1.11.0 Isola bridge for every clawith number. A missing
      // agent/binding or any bridge error returns null → native fallback (contained,
      // tenant-scoped) — it never falls through to the legacy runtime.
      const clawithResult = await tryIsolaBridge({
        agentId: clawithBinding.clawith_agent_id,
        messages,
        sessionId,
        callerPhone: senderPhone,
      });
      if (clawithResult) {
        return { ...clawithResult, model: 'clawith' };
      }
      console.warn('[brain-provider] Isola bridge failed — falling back to native for this reply');
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
}): Promise<{ text: string; tokensUsed: number; provider: 'hermes'; needsHandoff?: boolean; actions?: unknown } | null> {
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
    // needs_handoff/actions are read opportunistically — Hermes's documented
    // contract above doesn't list needs_handoff today, but this plumbing was
    // previously dead even for the already-live `actions` field; capturing
    // both here means nothing needs to change in this function again if/when
    // Hermes starts sending either.
    return {
      text,
      tokensUsed: 0,
      provider: 'hermes',
      needsHandoff: data?.needs_handoff === true,
      actions: data?.actions,
    };
  } catch (err: any) {
    console.error('[brain-provider] Hermes request error:', err?.message ?? err);
    return null;
  }
}

// ── Clawith implementation ────────────────────────────────────────────────────
//
// Two implementations, gated per-number by ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS
// above: tryIsolaBridge() (new v1.11.0 stack) for allowlisted numbers, and
// tryClawithLegacy() (original contract) for every other clawith tenant. This
// keeps the v1.11.0 cutover scoped to one number without disturbing tenants
// already live on the legacy endpoint with old clawith_agent_ids.

/**
 * Calls the Isola bridge on the v1.11.0 Clawith stack DIRECTLY — this
 * retires the bff-v2 hop that the hermes path above still goes through, and
 * supersedes the old runtime.epic.dm/api/internal/dispatch contract (which
 * required paperclip_agent_id/paperclip_company_id). One shared endpoint for
 * every clawith tenant; the per-tenant identity (clawith_agent_id) comes
 * from the caller's ClawithBinding row, not from any URL configuration.
 *
 * Contract (Foundation → Isola bridge):
 *   POST https://agents.epic.dm/api/isola/bridge/message
 *   headers: { 'X-Isola-Secret': CLAWITH_SHARED_SECRET }
 *   body: { agent_id, phone, text, external_conversation_id }
 *   expects: { reply: string, run_id, status, matched_session, needs_handoff?: boolean }
 *
 * Any non-2xx, network error, or empty reply is treated identically: return
 * null so the caller falls back to native. Never throws.
 */
const ISOLA_BRIDGE_URL =
  process.env.ISOLA_BRIDGE_URL || 'https://agents.epic.dm/api/isola/bridge/message';
// No published SLA for the bridge's round-trip; mirrors Hermes's generous
// timeout so a slow-but-healthy reply isn't mistaken for a dead endpoint.
const CLAWITH_TIMEOUT_MS = 45_000;

async function tryIsolaBridge(params: {
  agentId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
  callerPhone: string;
}): Promise<{ text: string; tokensUsed: number; provider: 'clawith'; needsHandoff: boolean } | null> {
  const secret = process.env.CLAWITH_SHARED_SECRET;
  if (!secret) {
    console.warn('[brain-provider] CLAWITH_SHARED_SECRET not configured — cannot use clawith provider');
    return null;
  }

  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content ?? '';
  if (!userText) return null;

  try {
    const res = await fetch(ISOLA_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Isola-Secret': secret },
      body: JSON.stringify({
        agent_id: params.agentId,
        phone: params.callerPhone,
        text: userText,
        external_conversation_id: params.sessionId,
      }),
      signal: AbortSignal.timeout(CLAWITH_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[brain-provider] Isola bridge failed (${res.status}): ${await res.text().catch(() => '')}`);
      return null; // falls back to native
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.reply === 'string' ? data.reply.trim() : '';
    if (!text) {
      console.error('[brain-provider] Isola bridge: no reply text');
      return null;
    }

    return { text, tokensUsed: 0, provider: 'clawith', needsHandoff: data?.needs_handoff === true };
  } catch (err: any) {
    console.error('[brain-provider] Isola bridge error:', err?.message ?? err);
    return null;
  }
}

/**
 * Calls Clawith's ORIGINAL dispatch endpoint DIRECTLY — this retires the
 * bff-v2 hop that the hermes path above still goes through. One shared
 * endpoint for every legacy clawith tenant; the per-tenant identity
 * (clawith_agent_id / paperclip_agent_id / paperclip_company_id) comes from
 * the caller's ClawithBinding row, not from any URL configuration.
 *
 * Contract (Foundation → Clawith):
 *   POST https://runtime.epic.dm/api/internal/dispatch
 *   headers: { Authorization: 'Bearer ' + CLAWITH_SHARED_SECRET } — the same
 *     shared secret bff-v2 already uses as BFF_CLAWITH_SHARED_SECRET.
 *   body: { agent_id, paperclip_agent_id, paperclip_company_id, user_text,
 *     history, session_id, caller_phone } — agent_id/paperclip_agent_id/
 *     paperclip_company_id are all required by Clawith.
 *   expects: { draft: string, needs_handoff: boolean, errors?: unknown }
 *
 * Clawith fails CLOSED on its own downstream outage (503 when Paperclip is
 * unreachable) — any non-2xx here is therefore treated exactly like a
 * network error: return null so the caller falls back to native. Never throws.
 */
const CLAWITH_DISPATCH_URL = 'https://runtime.epic.dm/api/internal/dispatch';

async function tryClawithLegacy(params: {
  agentId: string;
  paperclipAgentId: string;
  paperclipCompanyId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
  callerPhone: string;
  /** When present, Clawith overrides its sandbox Odoo with the tenant's own connection. */
  odooBinding: OdooBindingInput | null;
}): Promise<{ text: string; tokensUsed: number; provider: 'clawith'; needsHandoff: boolean } | null> {
  const sharedSecret = process.env.CLAWITH_SHARED_SECRET;
  if (!sharedSecret) {
    console.warn('[brain-provider] CLAWITH_SHARED_SECRET not configured — cannot use clawith provider');
    return null;
  }

  const lastUserMessage = [...params.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMessage?.content ?? '';
  if (!userText) return null;

  try {
    const res = await fetch(CLAWITH_DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify({
        agent_id: params.agentId,
        paperclip_agent_id: params.paperclipAgentId,
        paperclip_company_id: params.paperclipCompanyId,
        user_text: userText,
        history: params.messages.map((m) => ({ role: m.role, content: m.content })),
        session_id: params.sessionId,
        caller_phone: params.callerPhone,
        sandbox: false,
        // Tenant-owned Odoo credentials — only included when a binding exists.
        // Clawith ignores these fields when absent, using its own sandbox creds.
        ...(params.odooBinding && {
          odoo_url: params.odooBinding.url,
          odoo_db: params.odooBinding.db,
          odoo_login: params.odooBinding.login,
          odoo_password: params.odooBinding.password,
        }),
      }),
      signal: AbortSignal.timeout(CLAWITH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[brain-provider] Clawith dispatch failed (${res.status}): ${errText}`);
      return null;
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.draft === 'string' ? data.draft.trim() : '';
    if (!text) {
      console.error('[brain-provider] Clawith response had no usable draft field');
      return null;
    }

    return {
      text,
      tokensUsed: 0,
      provider: 'clawith',
      needsHandoff: data?.needs_handoff === true,
    };
  } catch (err: any) {
    console.error('[brain-provider] Clawith request error:', err?.message ?? err);
    return null;
  }
}
