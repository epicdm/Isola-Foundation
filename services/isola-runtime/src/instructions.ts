/**
 * Behaviour comes from Paperclip, at reply time.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-14 a customer asked +1 767-295-6737 what time EPIC opens and the agent
 * said it did not have the opening hours. EPIC's hours were written down — in a
 * `soul.md` the old runtime read and this one had never heard of. The compiled-in
 * `FRONT_DESK_PROMPT` answered anyway, confidently, from an empty context. **A silent
 * default that answers is how that defect happened**, so the fallback here does not
 * answer: it says it cannot help and escalates.
 *
 * The owner's ruling is that Paperclip is where the AI is configured. So the agent's
 * instructions bundle is the source of behaviour, fetched per reply, and an edit in
 * Paperclip is live on the next message.
 *
 * WHY THE RUNTIME FETCHES, NOT THE GATEWAY
 * ----------------------------------------
 * `registry.ts` states the law: a request may only *select* a template, never define
 * one, because a Paperclip employee can PATCH its own `adapterConfig`. If the gateway
 * fetched instructions and passed them in the invoke body, behaviour-bearing content
 * would arrive **in the request** and that law would be broken. So the runtime fetches
 * it itself, with its own credential, for an agent id resolved from configuration —
 * never from the request. The request still only selects a template.
 *
 * RESIDUAL RISK, STATED: whoever can edit the bundle in Paperclip controls what the
 * agent says. That is the intent — it is the owner's console — but it means Paperclip
 * board access is now customer-facing authority. Bundle edits are the change surface
 * to audit.
 */
import type { SafeFetch } from "./egress.js";

/**
 * Used when Paperclip cannot be read. It deliberately cannot answer a question about
 * the business: with no approved knowledge, answering is guessing, and guessing is the
 * failure this whole path exists to remove.
 */
export const FAIL_CLOSED_PROMPT = `You are a front desk assistant for this business, and you are currently unable to reach your approved business information.

You therefore do not know anything about this business: not its hours, prices, products, services, coverage, policies, or availability. You must not answer any question about them, and you must not guess, approximate, or reason from what similar businesses usually do.

Reply with a short, warm message that does three things and nothing else:
1. Say plainly that you cannot look this up right now.
2. Say that you are passing the message to a colleague who will follow up.
3. Ask for their name and the best number to reach them, if you do not already have both.

Do not answer the question they asked, even partially. Do not offer a range, a guess, or a "usually". Do not promise a callback time. Do not claim to have sent, logged or raised anything — you have not.

Keep it under 60 words. Plain sentences, no Markdown, no emoji.`;

/** A prompt must be non-trivial to be trusted; an empty file is a misconfiguration. */
const MIN_USABLE_PROMPT_CHARS = 200;

export function isUsablePrompt(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= MIN_USABLE_PROMPT_CHARS;
}

/** templateId -> Paperclip agent id. Configuration only; never from a request. */
export type InstructionsMap = Readonly<Record<string, string>>;

/**
 * Parse `PAPERCLIP_INSTRUCTIONS_MAP`. Invalid input yields an EMPTY map, which means
 * every template keeps its compiled-in prompt — a parse error must never silently
 * redirect behaviour to somewhere unexpected.
 */
export function parseInstructionsMap(raw: unknown): InstructionsMap {
  if (typeof raw !== "string" || raw.trim().length === 0) return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({});
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Object.freeze({});
  }
  const out: Record<string, string> = {};
  for (const [templateId, agentId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof agentId !== "string") continue;
    const id = agentId.trim();
    const key = templateId.trim();
    if (key.length === 0 || id.length === 0) continue;
    out[key] = id;
  }
  return Object.freeze(out);
}

export type PromptSource = "paperclip" | "compiled_in" | "fail_closed";

export interface ResolvedPrompt {
  readonly prompt: string;
  readonly source: PromptSource;
  /** Age of the cached copy in ms; 0 on a fresh fetch, null when not cached. */
  readonly cacheAgeMs: number | null;
  /** Present when Paperclip was configured for this template but could not be read. */
  readonly failure: string | null;
  /**
   * The Paperclip agent id whose BUSINESS.md is actually present in `prompt`, or
   * `null` when no business facts are attached (no `deps.map` entry for this
   * template, no BUSINESS.md uploaded yet, or the fetch failed). ALWAYS the same
   * admin-configured id `deps.map[templateId]` already resolves for the persona
   * fetch -- never a caller-supplied value; nothing in the request can change it.
   *
   * Exists so a caller (a setup demonstration, a log line, an audit) can tell
   * WHICH tenant's facts, if any, actually reached the model on this reply,
   * instead of guessing from whether the prompt string happens to be long. A
   * templateId shared by more than one live Paperclip agent still resolves to
   * exactly one configured id here -- see the note on `parseInstructionsMap` and
   * defect-isolart-runtime-no-per-tenant-business-knowledge-2026-09-17. This field
   * makes that single-tenant-per-template limit visible rather than silent; it does
   * not lift it.
   */
  readonly businessFactsAgentId: string | null;
}

/**
 * How far past the TTL a cached prompt may still be served when Paperclip is
 * unreachable. Small on purpose: a brief blip should not take the front desk down,
 * but a sustained outage must not leave a stale script answering customers.
 */
export const GRACE_MULTIPLIER = 10;

export interface InstructionsProviderDeps {
  readonly baseUrl: string;
  readonly map: InstructionsMap;
  /** Reads the board token at call time so a rotated secret is picked up. */
  readonly readToken: () => string;
  /**
   * NOTE THE NAME. `test/no-direct-network.test.ts` scans src/ for `\bfetch\s*\(`
   * and permits it only in egress.ts. `safeFetch(` passes that scan because the
   * capital F breaks the word boundary. Do not rename this to `fetch`.
   */
  readonly safeFetch: SafeFetch;
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly now?: () => number;
}

interface CacheEntry {
  prompt: string;
  fetchedAt: number;
  /** Whether `prompt` has BUSINESS.md content appended -- see ResolvedPrompt. */
  businessFactsAttached: boolean;
}

export interface InstructionsProvider {
  /**
   * Resolve the system prompt for a template. Never throws: a template with no
   * Paperclip binding keeps its compiled-in prompt, and a binding that cannot be
   * read yields the fail-closed prompt.
   */
  resolve(templateId: string, compiledIn: string): Promise<ResolvedPrompt>;
  /** Drop cached copies so the next reply re-reads Paperclip. */
  invalidate(templateId?: string): void;
}

export function createInstructionsProvider(deps: InstructionsProviderDeps): InstructionsProvider {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  const origin = deps.baseUrl.replace(/\/+$/, "");

  /**
   * Optional supplementary business knowledge (BUSINESS.md), fetched from the SAME
   * instructions bundle as AGENTS.md, by the SAME config-resolved agentId, with the
   * SAME credential -- never a second, request-suppliable identifier. This is the
   * previously-missing connection: a per-tenant business profile (name, hours,
   * services, policies -- produced by the existing business-discovery scan) can now
   * reach the model, through the one channel registry.ts's law already permits
   * behaviour-bearing content to travel by (the runtime's own fetch, keyed by
   * configuration, never by the request). Deliberately fail-SOFT, not fail-closed:
   * a template with no BUSINESS.md file is a normal, expected state (nothing has
   * been discovered/uploaded for it yet), not an outage of the persona itself --
   * the FAIL_CLOSED_PROMPT stays reserved for AGENTS.md being unreachable.
   */
  async function fetchBusinessFacts(agentId: string): Promise<string | null> {
    const url = `${origin}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=BUSINESS.md`;
    try {
      const res = await deps.safeFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.readToken()}` },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (!res.ok) return null; // no BUSINESS.md for this agent yet -- not an error
      const body = (await res.json()) as { content?: unknown };
      if (typeof body.content !== "string" || body.content.trim().length === 0) return null;
      return body.content.trim();
    } catch {
      return null; // fail-soft: supplementary knowledge, never blocks the reply
    }
  }

  async function fetchEntry(
    agentId: string,
  ): Promise<{ prompt: string; businessFactsAttached: boolean }> {
    const url = `${origin}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=AGENTS.md`;
    const res = await deps.safeFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.readToken()}` },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`instructions-bundle/file returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { content?: unknown };
    if (!isUsablePrompt(body.content)) {
      throw new Error(
        `instructions bundle is empty or too short to be a prompt (${
          typeof body.content === "string" ? `${body.content.trim().length} chars` : typeof body.content
        })`,
      );
    }
    const persona = body.content.trim();
    // Fetched by the SAME agentId as the persona above -- same trust boundary, same
    // tenant scope. A business-facts fetch failure never fails the persona fetch.
    const businessFacts = await fetchBusinessFacts(agentId);
    if (businessFacts === null) return { prompt: persona, businessFactsAttached: false };
    return {
      prompt: `${persona}\n\n----- BUSINESS INFORMATION (from the tenant's own discovery profile) -----\n${businessFacts}\n----- END BUSINESS INFORMATION -----`,
      businessFactsAttached: true,
    };
  }

  return {
    async resolve(templateId, compiledIn) {
      const agentId = deps.map[templateId];
      if (agentId === undefined) {
        return {
          prompt: compiledIn,
          source: "compiled_in",
          cacheAgeMs: null,
          failure: null,
          businessFactsAgentId: null,
        };
      }

      const cached = cache.get(templateId);
      if (cached !== undefined) {
        const age = now() - cached.fetchedAt;
        if (age < deps.ttlMs) {
          return {
            prompt: cached.prompt,
            source: "paperclip",
            cacheAgeMs: age,
            failure: null,
            businessFactsAgentId: cached.businessFactsAttached ? agentId : null,
          };
        }
      }

      try {
        const { prompt, businessFactsAttached } = await fetchEntry(agentId);
        cache.set(templateId, { prompt, fetchedAt: now(), businessFactsAttached });
        return {
          prompt,
          source: "paperclip",
          cacheAgeMs: 0,
          failure: null,
          businessFactsAgentId: businessFactsAttached ? agentId : null,
        };
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        // A cached copy is better than refusing to serve, but it is NOT unbounded:
        // once it is older than the grace window the agent stops speaking for the
        // business rather than speaking from a stale script.
        if (cached !== undefined && now() - cached.fetchedAt < deps.ttlMs * GRACE_MULTIPLIER) {
          return {
            prompt: cached.prompt,
            source: "paperclip",
            cacheAgeMs: now() - cached.fetchedAt,
            failure,
            businessFactsAgentId: cached.businessFactsAttached ? agentId : null,
          };
        }
        return {
          prompt: FAIL_CLOSED_PROMPT,
          source: "fail_closed",
          cacheAgeMs: null,
          failure,
          businessFactsAgentId: null,
        };
      }
    },

    invalidate(templateId) {
      if (templateId === undefined) cache.clear();
      else cache.delete(templateId);
    },
  };
}
