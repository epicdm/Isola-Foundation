/**
 * Agent-specific caller proof for business-facts-enabled templates.
 *
 * THE GAP THIS CLOSES
 * --------------------
 * `auth.ts` resolves a caller to an EXPOSURE CLASS (INTERNAL or PUBLIC) from a
 * single bearer shared by every template in that class. `agentId` in the
 * request body is otherwise purely descriptive — nothing before this module
 * checks that the caller is actually authorised to invoke AS that specific
 * agent. Measured 2026-09-18: the SAME shared value
 * (`settings.ISOLA_RUNTIME_BEARER`) is embedded in every Paperclip hire's
 * `adapterConfig.headers.Authorization` regardless of which agent it is — so
 * even Paperclip's own dispatch does not distinguish individual agents today.
 * That is fine for a template that never sees real business data. It stops
 * being fine the moment a template like `epic-staff-operations-coordinator@v1`
 * can be handed a live, tenant-scoped Odoo business briefing: at that point,
 * "holds the shared INTERNAL bearer" is not the same claim as "is authorised
 * to ask for THIS tenant's business facts under THIS agent's identity", and a
 * shared bearer alone cannot distinguish a legitimate caller from any other
 * holder of the same class-wide secret.
 *
 * THE MECHANISM
 * --------------
 * A SECOND, narrower proof, required ONLY for templates named in
 * `requiredForTemplateIds` (operator-configured; EMPTY by default — an
 * explicit opt-in, same "master switch off unless named" shape as
 * AGENTOS_ENABLED, and for the same reason: defaulting this ON for
 * `epic-staff-operations-coordinator@v1` would refuse Paperclip's OWN
 * existing dispatch to it the moment this shipped, since its adapterConfig
 * sends no `callerProof` today — see config.ts). The expected value per `agentId` is an
 * OPERATOR-CONFIGURED map (`RUNTIME_AGENT_CALLER_PROOF_MAP`), never derived
 * from the request and never customer-controlled — the same trust model as
 * every other runtime credential in this service. A caller invoking a gated
 * template must additionally supply `callerProof` in the request body,
 * matching the value configured for that exact `agentId`.
 *
 * FAILS CLOSED, EVERY SHAPE NAMED. A template not in the required set is
 * untouched (`not_required` — the exact behaviour every other template has
 * always had). A gated template with no `agentId`, no proof configured for
 * that `agentId`, no supplied proof, or a supplied proof that does not match
 * are FOUR DISTINCT refusal reasons — never collapsed into one generic
 * "unauthorized", so an operator reading a log knows which one happened.
 *
 * DEPLOYMENT STATE. `RUNTIME_AGENT_CALLER_PROOF_MAP` is unset in every
 * environment as of 2026-09-18 (same as `FOUNDATION_BASE_URL` /
 * `FOUNDATION_INTERNAL_TOKEN` on the isola-portal side — see
 * `foundation_client.py`). Until an operator populates it, EVERY caller for a
 * gated template gets `no_proof_configured_for_agent` — fails closed, not
 * open: an unconfigured map refuses every agent rather than admitting all of
 * them. This mirrors `RUNTIME_BUDGET_FALLBACK_CENTS`'s own "absence must
 * never silently become permissive" law.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type AgentCallerProofOutcome =
  /** This template is not in the gated set — the existing, unaffected behaviour. */
  | { kind: "not_required" }
  | { kind: "ok" }
  | { kind: "missing_agent_id" }
  | { kind: "missing_proof" }
  /** The map has no entry for this agentId — refuses even a syntactically valid caller. */
  | { kind: "no_proof_configured_for_agent" }
  | { kind: "proof_mismatch" };

/** Same technique as `auth.ts`'s `constantTimeEquals` — hash first so the
 *  comparison is over two equal-length buffers and neither string's length
 *  leaks through an early return. Duplicated rather than imported: this
 *  module must stay independently reviewable without pulling in auth.ts's
 *  exposure-class concerns. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export interface AgentCallerProofArgs {
  templateId: string;
  agentId: string | null;
  suppliedProof: string | null;
  requiredForTemplateIds: ReadonlySet<string>;
  proofByAgentId: Readonly<Record<string, string>>;
}

/**
 * Pure decision function — no I/O, no config lookup, mirroring
 * `agentos-allowlist.ts`'s `evaluateAgentOsEligibility` on purpose: this is
 * the second gate of the same shape, trivially unit-testable and auditable.
 * Called on every request; no caching, for the same reason a routing
 * decision is never cached in this service.
 */
export function verifyAgentCallerProof(args: AgentCallerProofArgs): AgentCallerProofOutcome {
  if (!args.requiredForTemplateIds.has(args.templateId)) {
    return { kind: "not_required" };
  }
  if (args.agentId === null || args.agentId.length === 0) {
    return { kind: "missing_agent_id" };
  }

  const expected = args.proofByAgentId[args.agentId];
  if (expected === undefined) {
    return { kind: "no_proof_configured_for_agent" };
  }

  if (args.suppliedProof === null || args.suppliedProof.length === 0) {
    return { kind: "missing_proof" };
  }

  return constantTimeEquals(args.suppliedProof, expected)
    ? { kind: "ok" }
    : { kind: "proof_mismatch" };
}
