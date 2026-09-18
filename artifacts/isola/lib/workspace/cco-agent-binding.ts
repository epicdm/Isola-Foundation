/**
 * Governed cross-service reads: resolving and listing the CCO agent(s) a
 * Foundation tenant actually owns.
 *
 * THE REVERSE OF THE TENANT-MAPPING READ
 * -----------------------------------------
 * `app/api/internal/tenant-mapping/route.ts` is the read isola-portal makes
 * INTO Foundation. These functions are the reads Foundation makes INTO
 * isola-portal (`apps.isola_provisioning.internal_views`) — symmetric shape,
 * same "governed HTTP call, never a shared table, never cached" law,
 * applied in the other direction. Foundation asserts nothing about which
 * agent is authorized; it asks isola-portal's own `IsolaAgentProvision`
 * record, live, every call.
 *
 * AGENT IDENTITY, NOT TEMPLATE MATCHING
 * -----------------------------------------
 * `resolveCcoAgentBinding` takes the SPECIFIC `paperclip_agent_id` the owner
 * selected (see `listCcoAgents` below for how a caller discovers the
 * choices) and resolves it by identity — never ambiguous, because
 * `paperclip_agent_id` is globally unique in isola-portal's own schema.
 * `listCcoAgents` is the genuinely template-keyed read: it returns every
 * executable agent this tenant has for the CCO template, zero, one or
 * several — several is the supported "two agents share a template" case,
 * a list for the caller to choose from, never picked between here.
 *
 * NAMED OUTCOMES, NEVER A BOOLEAN
 * -----------------------------------
 * Mirrors `foundation_client.py`'s own `MappingOutcome` vocabulary exactly,
 * because it is answering the same FAMILY of question with the same
 * ambiguity shapes: `unreachable` is never conflated with a genuine `no`.
 */

import { getPortalAgentBindingConfig } from '@/lib/engines';

export const CCO_TEMPLATE_ID = 'isola-internal-summarizer';

export type CcoAgentBindingOutcome =
  | { outcome: 'linked'; paperclipAgentId: string; paperclipCompanyId: string }
  | { outcome: 'tenant_not_mapped' }
  /** The claimed agent id does not resolve under THIS tenant — covers both
   *  a bogus id and a real id owned by a DIFFERENT tenant, deliberately
   *  collapsed into one response (see internal_views.py's own docstring):
   *  existence under the wrong tenant is never confirmed. */
  | { outcome: 'not_found' }
  | { outcome: 'not_ready' }
  | { outcome: 'not_configured' }
  /** The request did not complete, or completed unreadably. Distinct from
   *  every named "no" above: says nothing about whether a binding exists. */
  | { outcome: 'unreachable'; detail: string };

export interface CcoAgentCatalogEntry {
  paperclipAgentId: string;
  paperclipCompanyId: string;
  displayName: string;
}

export type CcoAgentCatalogOutcome =
  | { outcome: 'listed'; agents: CcoAgentCatalogEntry[] }
  | { outcome: 'tenant_not_mapped' }
  | { outcome: 'not_configured' }
  | { outcome: 'unreachable'; detail: string };

const REQUEST_TIMEOUT_MS = 10_000;

async function getJson(path: string, params: Record<string, string>): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; outcome: 'not_configured' | 'unreachable'; detail?: string }
> {
  const config = getPortalAgentBindingConfig();
  if (config === null) return { ok: false, outcome: 'not_configured' };

  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, outcome: 'unreachable', detail: err instanceof Error ? err.name : 'unknown_error' };
  }

  if (res.status !== 200) {
    // Includes 401 (bad/rotated token) and 5xx. Neither means "not linked"
    // — both mean the question could not be answered.
    return { ok: false, outcome: 'unreachable', detail: `http_${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, outcome: 'unreachable', detail: 'unreadable_body' };
  }

  if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
    return { ok: false, outcome: 'unreachable', detail: 'malformed_response' };
  }

  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * One bounded, read-only GET, resolving ONE specific owner-selected agent by
 * identity. Never retried, never cached here — the same "resolve live" shape
 * as `resolve_paperclip_company_id` in isola-portal.
 */
export async function resolveCcoAgentBinding(
  foundationTenantId: string,
  paperclipAgentId: string,
): Promise<CcoAgentBindingOutcome> {
  const result = await getJson('/api/isola/internal/agent-binding/', {
    foundation_tenant_id: foundationTenantId,
    agent_id: paperclipAgentId,
  });
  if (!result.ok) {
    return result.outcome === 'not_configured'
      ? { outcome: 'not_configured' }
      : { outcome: 'unreachable', detail: result.detail ?? '' };
  }

  const state = result.body.state;
  if (state === 'tenant_not_mapped' || state === 'not_found' || state === 'not_ready') {
    return { outcome: state };
  }
  if (state === 'linked') {
    const agentId = result.body.paperclip_agent_id;
    const companyId = result.body.paperclip_company_id;
    if (typeof agentId !== 'string' || agentId.length === 0 || typeof companyId !== 'string' || companyId.length === 0) {
      // A "linked" state with no real id is unreadable, not linked — never
      // proceed to invoke the runtime with an empty agentId.
      return { outcome: 'unreachable', detail: 'linked_state_missing_ids' };
    }
    // DEFENSE IN DEPTH, FOUND BY CODEX REVIEW (2026-09-18): this call asked
    // the portal to resolve ONE specific, owner-selected agent
    // (`agent_id: paperclipAgentId` above) — the response is trusted to
    // answer that exact question, but nothing previously checked that it
    // did. Under a malformed or buggy portal response (the same class of
    // defect CLAUDE.md's own register already names for ghost-id lookups),
    // Foundation would silently invoke whatever agent the response
    // happened to name, not the one actually requested/authorized — a
    // cross-tenant invocation with no client-side check at all. The portal
    // is the source of truth for WHICH tenant an agent belongs to; this is
    // not re-deriving that, only refusing to act on an answer that
    // disagrees with the question that was asked.
    if (agentId !== paperclipAgentId) {
      return { outcome: 'unreachable', detail: 'linked_state_agent_id_mismatch' };
    }
    return { outcome: 'linked', paperclipAgentId: agentId, paperclipCompanyId: companyId };
  }
  return { outcome: 'unreachable', detail: 'unrecognised_state' };
}

/**
 * Lists every executable CCO-template agent this tenant has, for a caller
 * with no prior selection to choose from. Zero, one or several are all
 * valid answers.
 */
export async function listCcoAgents(foundationTenantId: string): Promise<CcoAgentCatalogOutcome> {
  const result = await getJson('/api/isola/internal/agent-catalog/', {
    foundation_tenant_id: foundationTenantId,
    template_id: CCO_TEMPLATE_ID,
  });
  if (!result.ok) {
    return result.outcome === 'not_configured'
      ? { outcome: 'not_configured' }
      : { outcome: 'unreachable', detail: result.detail ?? '' };
  }

  const state = result.body.state;
  if (state === 'tenant_not_mapped') return { outcome: 'tenant_not_mapped' };
  if (state !== 'listed') return { outcome: 'unreachable', detail: 'unrecognised_state' };

  const rawAgents = result.body.agents;
  if (!Array.isArray(rawAgents)) return { outcome: 'unreachable', detail: 'malformed_agents_list' };

  const agents: CcoAgentCatalogEntry[] = [];
  for (const raw of rawAgents) {
    if (typeof raw !== 'object' || raw === null) continue;
    const agentId = (raw as Record<string, unknown>).paperclip_agent_id;
    const companyId = (raw as Record<string, unknown>).paperclip_company_id;
    const displayName = (raw as Record<string, unknown>).display_name;
    if (typeof agentId !== 'string' || agentId.length === 0) continue;
    if (typeof companyId !== 'string' || companyId.length === 0) continue;
    agents.push({
      paperclipAgentId: agentId,
      paperclipCompanyId: companyId,
      displayName: typeof displayName === 'string' ? displayName : '',
    });
  }
  return { outcome: 'listed', agents };
}
