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
 * it itself, with its own credential, for a PERSONA agent id resolved from
 * configuration (`PAPERCLIP_INSTRUCTIONS_MAP`) — never from the request. The request
 * still only selects a template. This is deliberately unaffected by everything below:
 * a template's persona (AGENTS.md) is meant to be the SAME reusable behaviour script
 * for every tenant instantiating that template, by design.
 *
 * WHY BUSINESS FACTS ARE DIFFERENT, AND WHY A TEMPLATE-ID KEY IS NOT ENOUGH
 * --------------------------------------------------------------------------
 * BUSINESS.md is per-TENANT, not per-template: `isola-ai-sales-front-desk-agent@v1` is
 * shared by more than one live Paperclip agent (confirmed live 2026-09-17), so keying
 * the business-facts fetch by `PAPERCLIP_INSTRUCTIONS_MAP[templateId]` -- one admin-set
 * agent id per template -- can only ever serve ONE tenant's facts to every caller of
 * that template, silently. This module used to do exactly that (see defect
 * defect-isolart-runtime-no-per-tenant-business-knowledge-2026-09-17).
 *
 * The fix is NOT to trust `body.agentId` (the invoke request's claimed agent id) on its
 * own -- that is genuinely gateway-supplied (isola-gateway resolves it from its own
 * `GATEWAY_BINDINGS_JSON`, matched on the SIGNED webhook's account/inbox id, never from
 * message content -- see `services/isola-gateway/src/{bindings,pipeline}.ts`), but nothing
 * downstream of that gateway process cryptographically ties the claim to anything. A
 * caller holding the shared `RUNTIME_SECRET_PUBLIC` bearer -- which is not scoped to one
 * agent -- could otherwise claim ANY agent id and, if that id happened to be real, receive
 * that tenant's actual business facts. Note the distinction this module now enforces:
 * PERMISSION TO READ AN AGENT'S RECORD (which Paperclip's own board-scoped credential
 * already grants broadly within a company -- see `paperclip.ts`) is not the same thing as
 * PROOF THAT THIS INVOCATION LEGITIMATELY BELONGS TO THAT AGENT. Reading Paperclip's own
 * `adapterConfig.payloadTemplate.templateId` for a claimed agent id (measured live,
 * 2026-09-17: 403, this runtime's board credential lacks the `agents:create`-equivalent
 * grant `GET /agents/:id/configuration` requires) would answer the first question, never
 * the second -- Paperclip has no concept of which Isola invocation is entitled to which
 * agent's business facts, because it has no concept of "invocation" at all.
 *
 * So the authority is local and admin-published, the same trust model
 * `PAPERCLIP_INSTRUCTIONS_MAP` already uses for personas, just inverted and widened to
 * many-agents-per-template: `PAPERCLIP_BUSINESS_FACTS_MAP` (agent id -> the ONE templateId
 * that agent id is authorized to run business-fact resolution under, mirroring the real,
 * one-templateId-per-agent shape of a Paperclip employee's own `adapterConfig`). The
 * invoke's claimed `agentId` is CHECKED against this table and the invoked `templateId`
 * -- never merely consulted. Absent from the table, or present under a DIFFERENT
 * templateId than the one actually invoked (a forged or stale claim), yields no business
 * facts at all -- never another tenant's. Setting this table is a deploy-time operator
 * decision, exactly like `PAPERCLIP_INSTRUCTIONS_MAP` already is, and requires no new
 * Paperclip permission grant.
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

/** Paperclip agent id -> the ONE templateId that agent is authorized to run business-fact resolution under. */
export type BusinessFactsAuthorizationMap = Readonly<Record<string, string>>;

/**
 * Parse `PAPERCLIP_BUSINESS_FACTS_MAP`. Same shape and same parsing rules as
 * `parseInstructionsMap` (non-empty string keys and values; anything malformed yields
 * an EMPTY map), just inverted: the key is an agent id, the value is the templateId it
 * is authorized for. Absent means "no agent is authorized" -- BUSINESS.md resolution is
 * fail-CLOSED-to-nothing by default, never fail-open to the old templateId-only keying.
 */
export function parseBusinessFactsMap(raw: unknown): BusinessFactsAuthorizationMap {
  return parseInstructionsMap(raw);
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
   * `null` when no business facts are attached. Non-null only when the invocation's
   * claimed agent id was found in `PAPERCLIP_BUSINESS_FACTS_MAP` AUTHORIZED for
   * exactly this `templateId`, AND that agent has a BUSINESS.md uploaded, AND the
   * fetch succeeded (or a fresh-enough cached copy exists). Absent claim, unauthorized
   * claim, template mismatch (a forged or stale claim naming a real agent id
   * authorized for a DIFFERENT template), and fetch failure are all indistinguishable
   * from the caller's perspective -- all of them yield `null`, never another tenant's
   * content. See the module-level comment for why a claimed agent id is CHECKED
   * against an admin-published table rather than merely consulted.
   *
   * Exists so a caller (a setup demonstration, a log line, an audit) can tell WHICH
   * tenant's facts, if any, actually reached the model on this reply, instead of
   * guessing from whether the prompt string happens to be long.
   */
  readonly businessFactsAgentId: string | null;
  /**
   * Set ONLY when the invocation carried a claimed agent id that FAILED
   * authorization (absent from `PAPERCLIP_BUSINESS_FACTS_MAP`, or present but
   * authorized for a different templateId than the one actually invoked) -- `null`
   * in every other case, including the ordinary "no claim at all" and "authorized but
   * no BUSINESS.md yet" cases. This is deliberately a SEPARATE field from
   * `businessFactsAgentId` rather than an inferred negative of it, because a rejected
   * claim is a distinct, log-worthy event (a forged or stale identity, or a gateway
   * binding bug) and must not be conflated with the routine "nothing uploaded yet"
   * case.
   */
  readonly businessFactsRejectedAgentId: string | null;
}

/**
 * How far past the TTL a cached prompt may still be served when Paperclip is
 * unreachable. Small on purpose: a brief blip should not take the front desk down,
 * but a sustained outage must not leave a stale script answering customers.
 */
export const GRACE_MULTIPLIER = 10;

export interface InstructionsProviderDeps {
  readonly baseUrl: string;
  /** templateId -> persona agent id. Configuration only; never from a request. */
  readonly map: InstructionsMap;
  /**
   * Agent id -> the ONE templateId that agent is authorized to run business-fact
   * resolution under. Configuration only; the invoke's claimed agent id is CHECKED
   * against this, never trusted directly. Absent (default `{}`) means no agent is
   * authorized -- BUSINESS.md resolution is off until an operator opts an agent in.
   */
  readonly businessFactsMap: BusinessFactsAuthorizationMap;
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

interface PersonaCacheEntry {
  prompt: string;
  fetchedAt: number;
}

interface BusinessCacheEntry {
  /** The raw fetched BUSINESS.md text, never the composed prompt -- composed fresh per call. */
  facts: string;
  fetchedAt: number;
}

export interface InstructionsProvider {
  /**
   * Resolve the system prompt for a template. Never throws: a template with no
   * Paperclip binding keeps its compiled-in prompt, and a binding that cannot be
   * read yields the fail-closed prompt.
   *
   * @param claimedAgentId The invocation's claimed agent id (gateway-supplied --
   *   see the module-level comment), or `null` when the invocation carried none.
   *   Used ONLY to look up business-fact authorization; it can never override, add
   *   to, or redirect the persona resolved from `templateId` via `deps.map`.
   */
  resolve(
    templateId: string,
    compiledIn: string,
    claimedAgentId: string | null,
  ): Promise<ResolvedPrompt>;
  /** Drop cached copies so the next reply re-reads Paperclip. */
  invalidate(templateId?: string): void;
}

export function createInstructionsProvider(deps: InstructionsProviderDeps): InstructionsProvider {
  const now = deps.now ?? (() => Date.now());
  const personaCache = new Map<string, PersonaCacheEntry>();
  const businessCache = new Map<string, BusinessCacheEntry>();
  const origin = deps.baseUrl.replace(/\/+$/, "");

  async function fetchPersona(agentId: string): Promise<string> {
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
    return body.content.trim();
  }

  /**
   * Resolve the persona for `templateId` via `deps.map` -- UNCHANGED mechanism, one
   * admin-configured agent id per template, meant to be the same reusable behaviour
   * script for every tenant instantiating that template. Never touches `businessCache`
   * or any claimed agent id.
   */
  async function resolvePersona(
    templateId: string,
    compiledIn: string,
  ): Promise<Omit<ResolvedPrompt, "businessFactsAgentId" | "businessFactsRejectedAgentId">> {
    const agentId = deps.map[templateId];
    if (agentId === undefined) {
      return { prompt: compiledIn, source: "compiled_in", cacheAgeMs: null, failure: null };
    }

    const cached = personaCache.get(templateId);
    if (cached !== undefined) {
      const age = now() - cached.fetchedAt;
      if (age < deps.ttlMs) {
        return { prompt: cached.prompt, source: "paperclip", cacheAgeMs: age, failure: null };
      }
    }

    try {
      const prompt = await fetchPersona(agentId);
      personaCache.set(templateId, { prompt, fetchedAt: now() });
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
  }

  /**
   * The invocation's claimed agent id is CHECKED here, never merely consulted: it must
   * be present in `deps.businessFactsMap` AND authorized for EXACTLY the templateId
   * actually being invoked. A real agent id authorized for a DIFFERENT template is a
   * mismatched (forged or stale) claim and is rejected the same as an absent one --
   * this is the one place a spoofed identity is caught.
   */
  function authorizedBusinessAgent(templateId: string, claimedAgentId: string | null): string | null {
    if (claimedAgentId === null) return null;
    const authorizedTemplateId = deps.businessFactsMap[claimedAgentId];
    if (authorizedTemplateId === undefined) return null;
    if (authorizedTemplateId !== templateId) return null;
    return claimedAgentId;
  }

  /**
   * Optional supplementary business knowledge (BUSINESS.md), fetched from the SAME
   * instructions-bundle API AGENTS.md uses, by the AUTHORIZED agent id (see
   * `authorizedBusinessAgent`), with the SAME credential. Deliberately fail-SOFT, not
   * fail-closed: a template with no BUSINESS.md file is a normal, expected state
   * (nothing has been discovered/uploaded for it yet), not an outage of the persona
   * itself -- the FAIL_CLOSED_PROMPT stays reserved for AGENTS.md being unreachable.
   */
  async function fetchBusinessFacts(agentId: string): Promise<string | null> {
    const cached = businessCache.get(agentId);
    if (cached !== undefined && now() - cached.fetchedAt < deps.ttlMs) {
      return cached.facts;
    }
    const url = `${origin}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=BUSINESS.md`;
    try {
      const res = await deps.safeFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.readToken()}` },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (!res.ok) {
        businessCache.delete(agentId);
        return null; // no BUSINESS.md for this agent yet -- not an error
      }
      const body = (await res.json()) as { content?: unknown };
      if (typeof body.content !== "string" || body.content.trim().length === 0) {
        businessCache.delete(agentId);
        return null;
      }
      const facts = body.content.trim();
      businessCache.set(agentId, { facts, fetchedAt: now() });
      return facts;
    } catch {
      // fail-soft: supplementary knowledge, never blocks the reply. A grace-window
      // cached copy is still better than nothing, exactly as the persona fetch does.
      if (cached !== undefined && now() - cached.fetchedAt < deps.ttlMs * GRACE_MULTIPLIER) {
        return cached.facts;
      }
      return null;
    }
  }

  return {
    async resolve(templateId, compiledIn, claimedAgentId) {
      const persona = await resolvePersona(templateId, compiledIn);

      // Business facts are only ever attempted once persona resolution actually
      // reached Paperclip for this template -- a template with no persona binding at
      // all (compiled_in) or an unreachable one (fail_closed) is not a per-tenant
      // business path, so there is nothing to attach facts to.
      if (persona.source !== "paperclip") {
        return { ...persona, businessFactsAgentId: null, businessFactsRejectedAgentId: null };
      }

      const businessAgentId = authorizedBusinessAgent(templateId, claimedAgentId);
      if (businessAgentId === null) {
        // Distinguish "no claim at all" (ordinary) from "a claim was made and it
        // failed authorization" (log-worthy -- see businessFactsRejectedAgentId's doc).
        const rejected = claimedAgentId !== null ? claimedAgentId : null;
        return { ...persona, businessFactsAgentId: null, businessFactsRejectedAgentId: rejected };
      }

      const facts = await fetchBusinessFacts(businessAgentId);
      if (facts === null) {
        return { ...persona, businessFactsAgentId: null, businessFactsRejectedAgentId: null };
      }

      return {
        ...persona,
        prompt: `${persona.prompt}\n\n----- BUSINESS INFORMATION (from the tenant's own discovery profile) -----\n${facts}\n----- END BUSINESS INFORMATION -----`,
        businessFactsAgentId: businessAgentId,
        businessFactsRejectedAgentId: null,
      };
    },

    invalidate(templateId) {
      if (templateId === undefined) {
        personaCache.clear();
        businessCache.clear();
        return;
      }
      personaCache.delete(templateId);
      // businessCache is keyed by agent id, not templateId -- possibly several agents
      // per template (that is the whole point). Drop every one authorized for THIS
      // template, exactly, so a partial invalidate cannot leave a stale entry for one
      // tenant while clearing another's.
      for (const [agentId, authorizedTemplateId] of Object.entries(deps.businessFactsMap)) {
        if (authorizedTemplateId === templateId) businessCache.delete(agentId);
      }
    },
  };
}
