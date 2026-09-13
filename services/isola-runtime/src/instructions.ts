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
import type { Exposure } from "./registry.js";

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
  /**
   * Reads the credential at call time so a rotated secret is picked up. Receives the
   * calling template's exposure so a caller can prefer an exposure-scoped agent key
   * over a single shared board token — see the exposure-aware wiring note in app.ts's
   * construction of this provider for why that fallback exists.
   */
  readonly readToken: (exposure: Exposure | undefined) => string;
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
}

export interface InstructionsProvider {
  /**
   * Resolve the system prompt for a template. Never throws: a template with no
   * Paperclip binding keeps its compiled-in prompt, and a binding that cannot be
   * read yields the fail-closed prompt.
   */
  resolve(templateId: string, compiledIn: string, exposure?: Exposure): Promise<ResolvedPrompt>;
  /** Drop cached copies so the next reply re-reads Paperclip. */
  invalidate(templateId?: string): void;
}

export function createInstructionsProvider(deps: InstructionsProviderDeps): InstructionsProvider {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  const origin = deps.baseUrl.replace(/\/+$/, "");

  async function fetchEntry(agentId: string, token: string): Promise<string> {
    const url = `${origin}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=AGENTS.md`;
    const res = await deps.safeFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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
    return body.content.trim();
  }

  return {
    async resolve(templateId, compiledIn, exposure) {
      const agentId = deps.map[templateId];
      if (agentId === undefined) {
        return { prompt: compiledIn, source: "compiled_in", cacheAgeMs: null, failure: null };
      }

      // A mapping can exist globally (some exposure has SOME credential) while THIS
      // template's own exposure has none — e.g. only an INTERNAL agent key and no
      // board token, with a PUBLIC template still in the map. Treat that exactly
      // like "no binding for this template": compiled-in, never a doomed fetch with
      // an empty Bearer that would otherwise surface as a false fail_closed. Read
      // once and reuse below, rather than re-reading inside fetchEntry: readToken
      // is call-time-sensitive for rotation, and a single resolve() must act on one
      // consistent value.
      const token = deps.readToken(exposure);
      if (token === "") {
        return { prompt: compiledIn, source: "compiled_in", cacheAgeMs: null, failure: null };
      }

      const cached = cache.get(templateId);
      if (cached !== undefined) {
        const age = now() - cached.fetchedAt;
        if (age < deps.ttlMs) {
          return { prompt: cached.prompt, source: "paperclip", cacheAgeMs: age, failure: null };
        }
      }

      try {
        const prompt = await fetchEntry(agentId, token);
        cache.set(templateId, { prompt, fetchedAt: now() });
        return { prompt, source: "paperclip", cacheAgeMs: 0, failure: null };
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
          };
        }
        return { prompt: FAIL_CLOSED_PROMPT, source: "fail_closed", cacheAgeMs: null, failure };
      }
    },

    invalidate(templateId) {
      if (templateId === undefined) cache.clear();
      else cache.delete(templateId);
    },
  };
}
