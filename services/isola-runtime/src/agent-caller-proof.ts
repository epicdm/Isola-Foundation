/**
 * Agent-specific caller proof for the CCO template
 * (`epic-staff-operations-coordinator@v1`, INTERNAL exposure).
 *
 * THIS IS PR #139'S MECHANISM, EXTENDED — NOT A SECOND ONE
 * ------------------------------------------------------------
 * `auth.ts`'s `resolveCredential` already resolves, for any caller, whether
 * its OWN presented bearer proves it represents a specific `agentId`
 * (`credentialAgentId`) — that mechanism was built on
 * `feat/isola-runtime-business-facts-connection-2026-09-17` (PR #139, OPEN/
 * DRAFT, not deployed) to close a confirmed impersonation gap for
 * PUBLIC-exposure business-facts-enabled agents. This module does not
 * duplicate that: it reuses `credentialAgentId` exactly as PR #139 produces
 * it, and adds only the ONE thing PR #139 does not cover — an INTERNAL,
 * business-facts-INDEPENDENT template (the CCO, fed a live Odoo briefing as
 * caller-supplied `context`, never as BUSINESS.md/persona content) that
 * ALSO needs its invoking `agentId` proven, not merely claimed.
 *
 * `internalAgentCallerSecrets` (config.ts) is the symmetric, INTERNAL-side
 * counterpart of PR #139's `agentCallerSecrets` — same map shape, same
 * `resolveCredential` comparison, same constant-time discipline — checked in
 * auth.ts itself, not here. This module ONLY decides, given the
 * ALREADY-RESOLVED `credentialAgentId`, whether a specific template requires
 * it to equal the claimed `agentId`.
 *
 * THE GAP THIS CLOSES, RESTATED FOR THE INTERNAL SIDE
 * -------------------------------------------------------
 * The exposure-class bearer (RUNTIME_SECRET_INTERNAL) is shared by every
 * INTERNAL template and every caller — measured 2026-09-18, the SAME value
 * is embedded in every Paperclip hire's `adapterConfig` regardless of which
 * agent it is, so even Paperclip's own dispatch does not distinguish
 * individual agents by the shared bearer alone. That was fine while no
 * INTERNAL template saw real business data. It stops being fine once a
 * caller can hand `epic-staff-operations-coordinator@v1` a live,
 * tenant-scoped Odoo briefing: holding the shared INTERNAL bearer is not the
 * same claim as being authorized to ask for THIS tenant's business facts
 * under THIS agent's identity.
 *
 * MANDATORY, NOT OPT-IN, ONCE A TEMPLATE IS LISTED
 * -----------------------------------------------------
 * Same ruling PR #139 already applied to business-facts authorization
 * ("OWNER CORRECTION... there is now only ONE rule"): a template named in
 * `requiredForTemplateIds` gets NO invocation without a proven agent
 * identity — there is no "authorized template, unprotected caller" state.
 *
 * CORRECTED 2026-09-18 (owner ruling, directive-isola-codex-review-gate-2026-
 * 09-18, Codex review): `requiredForTemplateIds` is no longer purely
 * operator-opt-in. `config.ts`'s `MANDATORY_AGENT_CALLER_PROOF_TEMPLATE_IDS`
 * ALWAYS includes `epic-staff-operations-coordinator@v1` — hardcoded, never
 * configurable away — because it is the one template fed real, tenant-scoped
 * Odoo business data, and the owner ruled "missing agent-specific proof must
 * refuse before any private context or model invocation reaches [it] — not a
 * tolerated fallback, not something [Lane A gets] to soften ... absolute
 * requirement, no exception path." This DOES refuse Paperclip's own existing
 * dispatch the moment it ships, exactly the consequence the earlier opt-in
 * design was built to avoid — that consequence is now the intended, ruled-on
 * behaviour, not a regression: `RUNTIME_INTERNAL_AGENT_CALLER_SECRETS` must
 * be populated, keyed by the real paperclip_agent_id, before ANY caller
 * (including Paperclip's own dispatch) can invoke this template again.
 * `requiredForTemplateIds` still starts EMPTY for any OTHER, future template
 * (the master-switch-off shape `AGENTOS_ENABLED` uses) and an operator can
 * still opt additional templates in via `RUNTIME_AGENT_CALLER_PROOF_REQUIRED_
 * TEMPLATES` — that opt-in shape was never wrong in general, it was wrong
 * specifically for a template already carrying real business data.
 *
 * FAILS CLOSED, EVERY SHAPE NAMED. A template not in the required set is
 * untouched (`not_required`). A gated template with no `agentId` at all, a
 * caller with no agent-bound credential (`credentialAgentId: null` —
 * including every caller using only the shared class bearer), or a proven
 * identity that does not match the CLAIMED `agentId` are THREE DISTINCT
 * refusal reasons — never collapsed into one generic "unauthorized".
 *
 * NO INSECURE FALLBACK. There is no branch in this function, or in its
 * caller in app.ts, that treats a missing or mismatched proof as anything
 * other than a refusal — no legacy code path, no "unless this is Paperclip"
 * exception. A gated template's ONLY route to invocation is a caller whose
 * own credential proves the agent identity it claims.
 */

export type AgentCallerProofOutcome =
  /** This template is not in the gated set — the existing, unaffected behaviour. */
  | { kind: "not_required" }
  | { kind: "ok" }
  | { kind: "missing_agent_id" }
  /** The caller's own credential proves no agent identity at all — includes
   *  every caller presenting only the shared INTERNAL/PUBLIC class bearer. */
  | { kind: "no_agent_bound_credential" }
  /** The credential proves a DIFFERENT agent than the one claimed. */
  | { kind: "agent_identity_mismatch" };

export interface AgentCallerProofArgs {
  templateId: string;
  agentId: string | null;
  /** Resolved by auth.ts's `resolveCredential` — never derived from the
   *  request body, and never null for a caller who does not hold an
   *  agent-bound secret. */
  credentialAgentId: string | null;
  requiredForTemplateIds: ReadonlySet<string>;
}

/**
 * Pure decision function — no I/O, no config lookup, mirroring
 * `agentos-allowlist.ts`'s `evaluateAgentOsEligibility` on purpose: this is
 * the same shape of gate, trivially unit-testable and auditable. Called on
 * every request; no caching.
 */
export function verifyAgentCallerProof(args: AgentCallerProofArgs): AgentCallerProofOutcome {
  if (!args.requiredForTemplateIds.has(args.templateId)) {
    return { kind: "not_required" };
  }
  if (args.agentId === null || args.agentId.length === 0) {
    return { kind: "missing_agent_id" };
  }
  if (args.credentialAgentId === null) {
    return { kind: "no_agent_bound_credential" };
  }
  if (args.credentialAgentId !== args.agentId) {
    return { kind: "agent_identity_mismatch" };
  }
  return { kind: "ok" };
}
