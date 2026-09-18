/**
 * Governed cross-service read: "which specific Paperclip agent, if any, is
 * THIS Foundation tenant's linked, approved, executable instance of the CCO
 * template?"
 *
 * THE REVERSE OF THE TENANT-MAPPING READ
 * -----------------------------------------
 * `app/api/internal/tenant-mapping/route.ts` is the read isola-portal makes
 * INTO Foundation. This module is the read Foundation makes INTO
 * isola-portal (`apps.isola_provisioning.internal_views.AgentBindingView`) —
 * symmetric shape, same "governed HTTP call, never a shared table, never
 * cached" law, applied in the other direction. Foundation asserts nothing
 * about which agent is authorized; it asks isola-portal's own
 * `IsolaAgentProvision` record, live, every call.
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
  | { outcome: 'not_provisioned' }
  | { outcome: 'not_ready' }
  | { outcome: 'ambiguous' }
  | { outcome: 'not_configured' }
  /** The request did not complete, or completed unreadably. Distinct from
   *  every named "no" above: says nothing about whether a binding exists. */
  | { outcome: 'unreachable'; detail: string };

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One bounded, read-only GET. Never retried, never cached here — the same
 * "resolve live" shape as `resolve_paperclip_company_id` in isola-portal.
 */
export async function resolveCcoAgentBinding(foundationTenantId: string): Promise<CcoAgentBindingOutcome> {
  const config = getPortalAgentBindingConfig();
  if (config === null) return { outcome: 'not_configured' };

  const url = new URL('/api/isola/internal/agent-binding/', config.baseUrl);
  url.searchParams.set('foundation_tenant_id', foundationTenantId);
  url.searchParams.set('template_id', CCO_TEMPLATE_ID);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    return { outcome: 'unreachable', detail: err instanceof Error ? err.name : 'unknown_error' };
  }

  if (res.status !== 200) {
    // Includes 401 (bad/rotated token) and 5xx. Neither means "not linked"
    // — both mean the question could not be answered. Same discipline as
    // foundation_client.py's own non-200/404 handling.
    return { outcome: 'unreachable', detail: `http_${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { outcome: 'unreachable', detail: 'unreadable_body' };
  }

  if (typeof body !== 'object' || body === null || !('ok' in body) || (body as { ok?: unknown }).ok !== true) {
    return { outcome: 'unreachable', detail: 'malformed_response' };
  }

  const state = (body as { state?: unknown }).state;
  if (
    state === 'tenant_not_mapped' ||
    state === 'not_provisioned' ||
    state === 'not_ready' ||
    state === 'ambiguous'
  ) {
    return { outcome: state };
  }

  if (state === 'linked') {
    const agentId = (body as { paperclip_agent_id?: unknown }).paperclip_agent_id;
    const companyId = (body as { paperclip_company_id?: unknown }).paperclip_company_id;
    if (typeof agentId !== 'string' || agentId.length === 0 || typeof companyId !== 'string' || companyId.length === 0) {
      // A "linked" state with no real id is unreadable, not linked — never
      // proceed to invoke the runtime with an empty agentId.
      return { outcome: 'unreachable', detail: 'linked_state_missing_ids' };
    }
    return { outcome: 'linked', paperclipAgentId: agentId, paperclipCompanyId: companyId };
  }

  return { outcome: 'unreachable', detail: 'unrecognised_state' };
}
