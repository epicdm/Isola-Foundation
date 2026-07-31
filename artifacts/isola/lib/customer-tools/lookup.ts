/**
 * lookup.ts - Tool 1 of the governed Foundation customer-tool set.
 *
 * WHAT THIS IS
 *   A READ-ONLY, purpose-scoped lookup of the Odoo contact behind a live
 *   Chatwoot conversation, plus that contact active leads and opportunities.
 *   Clawith may REQUEST it; Foundation authorises and executes it. Nothing in
 *   this module writes.
 *
 * WHY IT IS NOT A GENERIC ODOO CLIENT
 *   The raw transport (engines/odoo.json2Call) can call any model and any
 *   method. Handing that surface to a model-proposed tool call is the whole
 *   risk. This module therefore accepts NO model, NO method, NO domain and NO
 *   field list from its caller. The models, the methods, the domains and the
 *   returned fields are all fixed here, in code, where they are diffable and
 *   reviewable. A tool argument can change WHICH conversation is being asked
 *   about; it can never change WHAT is asked.
 *
 * IDENTITY IS NEVER MODEL-SELECTED
 *   The phone number used for resolution must be one the TRANSPORT verified -
 *   the wa_id Meta signed for, carried through Chatwoot. A phone number that
 *   arrived inside the conversation text, or inside a tool argument the agent
 *   composed, is refused with `phone_lookup_not_permitted`. Otherwise a
 *   customer could read another customer records simply by typing a number,
 *   and the agent would helpfully oblige.
 *
 * TENANT SCOPING
 *   The Odoo instance is resolved per tenant through the ONE shared
 *   implementation (resolveOdooConfigForTenant), so a lookup cannot reach
 *   another tenant Odoo at all: there is no cross-tenant domain to get wrong,
 *   because there is no shared database. The tenant id is still validated
 *   before any call, so a blank or missing tenant fails closed instead of
 *   falling through to the platform default binding.
 *
 * AUTHORITY
 *   Every record returned carries its authoritative Odoo id and the instant it
 *   was read. This tool reports what Odoo said at `readAt` and nothing more -
 *   it is not a cache, and callers must not treat it as one.
 */
import { findCustomerByPhone, json2Call } from "@/engines/odoo"
import type { OdooConfig, OdooCustomer } from "@/engines/odoo"
import { resolveOdooConfigForTenant } from "@/lib/engine-bindings"

/** Stable tool name on the Foundation to Clawith wire contract. */
export const CUSTOMER_LOOKUP_TOOL = "crm.customer.lookup"

/**
 * The ONLY crm.lead fields this tool will ever return.
 *
 * Deliberately excludes every free-text internal field (description,
 * notes, chatter) - an agent that can read internal deal commentary back to
 * the customer it is about is a disclosure incident waiting for a slow day.
 */
export const LEAD_FIELDS = [
  "id",
  "name",
  "type",
  "stage_id",
  "user_id",
  "team_id",
  "partner_id",
  "expected_revenue",
  "probability",
  "date_deadline",
  "create_date",
  "write_date",
] as const

/** Hard ceiling on related records returned in one lookup. */
export const MAX_RELATED_RECORDS = 10

/** Odoo timeout for a single read in this tool. */
export const LOOKUP_TIMEOUT_MS = 15_000

export type CustomerLookupFailureCode =
  | "invalid_tenant"
  | "invalid_conversation_context"
  | "phone_lookup_not_permitted"
  | "no_resolvable_identity"
  | "odoo_unavailable"

/**
 * A phone number Foundation is willing to resolve an identity from.
 *
 * `verified` is not a courtesy flag the caller sets to be polite. It asserts
 * the number came from the signed transport envelope. It is typed as the
 * literal `true` so a caller cannot pass `verified: someBoolean` and have an
 * unverified number quietly satisfy the type.
 */
export interface VerifiedPhone {
  e164: string
  verified: true
}

export interface CustomerLookupInput {
  tenantId: string
  chatwootAccountId: string
  inboxId: string
  conversationId: string
  /** Chatwoot contact reference. Carried for audit; never used as an Odoo key. */
  contactRef: string
  /** Null when the transport did not verify a number for this conversation. */
  verifiedPhone: VerifiedPhone | null
  correlationId: string
}

export interface CustomerLookupPolicy {
  /** Tenant policy switch. When false, phone resolution is refused outright. */
  allowPhoneLookup: boolean
}

export const DEFAULT_LOOKUP_POLICY: CustomerLookupPolicy = { allowPhoneLookup: true }

export interface LeadSummary {
  id: number
  name: string
  /** Odoo crm.lead.type: "lead" or "opportunity". */
  kind: string
  stage: string | null
  salesperson: string | null
  salesTeam: string | null
  partnerId: number | null
  expectedRevenue: number | null
  probability: number | null
  deadline: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerLookupOk {
  ok: true
  tool: typeof CUSTOMER_LOOKUP_TOOL
  correlationId: string
  readAt: string
  customer: OdooCustomer | null
  leads: LeadSummary[]
  opportunities: LeadSummary[]
  /** True when Odoo held more related records than MAX_RELATED_RECORDS. */
  truncated: boolean
}

export interface CustomerLookupFailure {
  ok: false
  tool: typeof CUSTOMER_LOOKUP_TOOL
  correlationId: string
  code: CustomerLookupFailureCode
  detail: string
}

export type CustomerLookupResult = CustomerLookupOk | CustomerLookupFailure

/** Seam for tests. Production wiring is the default. */
export interface CustomerLookupDeps {
  resolveConfig: (tenantId: string) => Promise<OdooConfig>
  findCustomer: (config: OdooConfig, phone: string) => Promise<OdooCustomer | null>
  readLeads: (config: OdooConfig, partnerId: number) => Promise<Record<string, unknown>[]>
}

/**
 * The one crm.lead read this tool performs.
 *
 * Domain is fixed: this partner, not archived, not closed-lost. `limit` is
 * MAX_RELATED_RECORDS + 1 so the caller can be told the truth about
 * truncation rather than silently shown a prefix of reality.
 */
async function defaultReadLeads(config: OdooConfig, partnerId: number): Promise<Record<string, unknown>[]> {
  return (await json2Call(
    config,
    "crm.lead",
    "search_read",
    {
      domain: [
        ["partner_id", "=", partnerId],
        ["active", "=", true],
      ],
      fields: [...LEAD_FIELDS],
      order: "write_date desc",
      limit: MAX_RELATED_RECORDS + 1,
    },
    LOOKUP_TIMEOUT_MS,
  )) as Record<string, unknown>[]
}

const DEFAULT_DEPS: CustomerLookupDeps = {
  resolveConfig: resolveOdooConfigForTenant,
  findCustomer: findCustomerByPhone,
  readLeads: defaultReadLeads,
}

function nameOf(value: unknown): string | null {
  return Array.isArray(value) && typeof value[1] === "string" ? value[1] : null
}

function idOf(value: unknown): number | null {
  if (typeof value === "number") return value
  return Array.isArray(value) && typeof value[0] === "number" ? value[0] : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function toLeadSummary(row: Record<string, unknown>): LeadSummary {
  return {
    id: typeof row.id === "number" ? row.id : -1,
    name: typeof row.name === "string" ? row.name : "",
    kind: typeof row.type === "string" ? row.type : "lead",
    stage: nameOf(row.stage_id),
    salesperson: nameOf(row.user_id),
    salesTeam: nameOf(row.team_id),
    partnerId: idOf(row.partner_id),
    expectedRevenue: numberOrNull(row.expected_revenue),
    probability: numberOrNull(row.probability),
    deadline: stringOrNull(row.date_deadline),
    createdAt: stringOrNull(row.create_date),
    updatedAt: stringOrNull(row.write_date),
  }
}

function fail(
  correlationId: string,
  code: CustomerLookupFailureCode,
  detail: string,
): CustomerLookupFailure {
  return { ok: false, tool: CUSTOMER_LOOKUP_TOOL, correlationId, code, detail }
}

/**
 * Resolve the Odoo contact behind a conversation, with its active commercial
 * state. Read-only. Never throws for an expected condition - an unreachable
 * Odoo, a missing tenant and an unverified identity are all typed refusals the
 * orchestrator must handle, not exceptions to be swallowed somewhere upstream.
 */
export async function lookupCustomerAndLeads(
  input: CustomerLookupInput,
  policy: CustomerLookupPolicy = DEFAULT_LOOKUP_POLICY,
  deps: CustomerLookupDeps = DEFAULT_DEPS,
): Promise<CustomerLookupResult> {
  const correlationId = typeof input.correlationId === "string" ? input.correlationId : ""

  const tenantId = (input.tenantId ?? "").trim()
  if (!tenantId) {
    return fail(correlationId, "invalid_tenant", "tenantId is required - refusing to fall back to a platform default binding")
  }
  if (!correlationId) {
    return fail(correlationId, "invalid_conversation_context", "correlationId is required")
  }
  for (const [field, value] of [
    ["chatwootAccountId", input.chatwootAccountId],
    ["inboxId", input.inboxId],
    ["conversationId", input.conversationId],
    ["contactRef", input.contactRef],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return fail(correlationId, "invalid_conversation_context", `${field} is required`)
    }
  }

  if (!policy.allowPhoneLookup) {
    return fail(correlationId, "phone_lookup_not_permitted", "tenant policy disables phone-based customer resolution")
  }

  const phone = input.verifiedPhone
  if (!phone) {
    return fail(correlationId, "no_resolvable_identity", "no transport-verified phone for this conversation")
  }
  if (phone.verified !== true) {
    return fail(correlationId, "phone_lookup_not_permitted", "phone was not verified by the transport - refusing a model-supplied identity")
  }
  if (typeof phone.e164 !== "string" || phone.e164.replace(/\D/g, "").length < 7) {
    return fail(correlationId, "no_resolvable_identity", "verified phone is too short to resolve")
  }

  let config: OdooConfig
  try {
    config = await deps.resolveConfig(tenantId)
  } catch (err) {
    return fail(correlationId, "odoo_unavailable", err instanceof Error ? err.message : "tenant Odoo binding could not be resolved")
  }

  let customer: OdooCustomer | null
  try {
    customer = await deps.findCustomer(config, phone.e164)
  } catch (err) {
    return fail(correlationId, "odoo_unavailable", err instanceof Error ? err.message : "res.partner read failed")
  }

  const readAt = new Date().toISOString()

  if (!customer) {
    return {
      ok: true,
      tool: CUSTOMER_LOOKUP_TOOL,
      correlationId,
      readAt,
      customer: null,
      leads: [],
      opportunities: [],
      truncated: false,
    }
  }

  let rows: Record<string, unknown>[]
  try {
    rows = (await deps.readLeads(config, customer.id)) ?? []
  } catch (err) {
    return fail(correlationId, "odoo_unavailable", err instanceof Error ? err.message : "crm.lead read failed")
  }

  const truncated = rows.length > MAX_RELATED_RECORDS
  const summaries = rows.slice(0, MAX_RELATED_RECORDS).map(toLeadSummary)

  return {
    ok: true,
    tool: CUSTOMER_LOOKUP_TOOL,
    correlationId,
    readAt,
    customer,
    leads: summaries.filter((s) => s.kind !== "opportunity"),
    opportunities: summaries.filter((s) => s.kind === "opportunity"),
    truncated,
  }
}
