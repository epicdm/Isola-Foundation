/**
 * lead-create.ts - Tool 2 of the governed Foundation customer-tool set.
 *
 * Creates ONE crm.lead for a verified customer, exactly once, and proves what
 * it created by reading it back.
 *
 * TWO DIFFERENT PROTECTIONS, DO NOT CONFLATE THEM
 *   1. The ledger claim (lib/customer-tools/operation.ts) makes THIS operation
 *      exactly-once. It is the guarantee. A retry of the same authorised turn
 *      returns the recorded result and never re-executes.
 *   2. The suitable-existing-lead check is a COURTESY, not a guarantee. It
 *      catches a lead a HUMAN or an earlier conversation already opened for the
 *      same customer and the same service, so the agent does not stack a second
 *      one next to it. It is a heuristic and it is treated as one - it can miss,
 *      and when it misses the ledger still holds.
 *   Anyone tempted to delete (1) because (2) looks like it covers the same
 *   ground should read the header of operation.ts first.
 *
 * AUTHORITY
 *   A create response that echoes an id is not proof of what was stored. The
 *   lead is read back and checked - right partner, right source, right type,
 *   conversation reference actually present - before the operation is recorded
 *   as succeeded. If the readback fails the operation is recorded as FAILED
 *   with the id we did get, so a lead that exists but could not be proven is
 *   traceable rather than lost.
 *
 * WHAT IT WILL NOT DO
 *   No arbitrary model, method or field. No caller-supplied Odoo domain. No
 *   partner id the caller invented - the partner must come from Tool 1, which
 *   resolved it from a transport-verified identity.
 */
import { json2Call, findOrCreateUtmRecord } from "@/engines/odoo"
import type { OdooConfig } from "@/engines/odoo"
import { resolveOdooConfigForTenant } from "@/lib/engine-bindings"
import {
  claimOperation,
  completeOperation,
  failOperation,
  prismaOperationStore,
  type OperationStore,
} from "./operation"

export const LEAD_CREATE_TOOL = "crm.lead.create"

/**
 * The utm.source every AI-originated lead carries. One constant, so "where did
 * this lead come from" is answerable in Odoo by a human with a filter rather
 * than by an engineer with a query.
 */
export const ISOLA_LEAD_SOURCE = "WhatsApp / Isola AI"

/** Fields read back to prove what was stored. */
export const LEAD_READBACK_FIELDS = [
  "id",
  "name",
  "type",
  "partner_id",
  "contact_name",
  "phone",
  "source_id",
  "team_id",
  "user_id",
  "stage_id",
  "description",
  "active",
  "create_date",
] as const

export const MAX_QUALIFICATION_FACTS = 20
export const MAX_FACT_CHARS = 500
export const LEAD_TIMEOUT_MS = 20_000

export type LeadCreateFailureCode =
  | "invalid_tenant"
  | "invalid_input"
  | "lead_creation_not_permitted"
  | "operation_conflict"
  | "operation_in_flight"
  | "odoo_unavailable"
  | "readback_failed"

export interface LeadCreateInput {
  tenantId: string
  /** Odoo res.partner id, resolved by Tool 1 from a transport-verified identity. */
  partnerId: number
  contactName: string
  /** What the customer is asking about. Becomes the lead title. */
  serviceInterest: string
  /** Short factual statements captured during qualification. */
  qualificationFacts: string[]
  nextStep: string
  chatwootConversationId: string
  clawithSessionId: string
  correlationId: string
  /** Clawith idempotency hint. An input to the derived id, never the identity. */
  operationIdHint: string
  /** Configured routing. Absent means Odoo own assignment rules apply. */
  salesTeamId?: number | null
  salespersonUserId?: number | null
}

export interface LeadCreatePolicy {
  allowLeadCreation: boolean
}

export const DEFAULT_LEAD_CREATE_POLICY: LeadCreatePolicy = { allowLeadCreation: true }

export interface LeadRecord {
  id: number
  name: string
  type: string
  partnerId: number | null
  sourceName: string | null
  teamId: number | null
  userId: number | null
  stage: string | null
  active: boolean
  createdAt: string | null
}

export type LeadCreateResult =
  | { ok: true; tool: typeof LEAD_CREATE_TOOL; operationId: string; created: boolean; reused: "existing_lead" | "recorded_operation" | null; lead: LeadRecord }
  | { ok: false; tool: typeof LEAD_CREATE_TOOL; operationId: string | null; code: LeadCreateFailureCode; detail: string; leadId?: number }

export interface LeadCreateDeps {
  resolveConfig: (tenantId: string) => Promise<OdooConfig>
  findSuitableLead: (config: OdooConfig, partnerId: number, serviceInterest: string) => Promise<Record<string, unknown> | null>
  resolveSourceId: (config: OdooConfig, name: string) => Promise<number | null>
  createLead: (config: OdooConfig, vals: Record<string, unknown>) => Promise<number | null>
  readLead: (config: OdooConfig, leadId: number) => Promise<Record<string, unknown> | null>
  store: OperationStore
}

/**
 * A lead is "suitable" when it is OPEN, belongs to this partner, and already
 * names this service interest. Deliberately narrow: a broad match would silently
 * attach a new conversation to an unrelated old deal, which is worse than a
 * duplicate because it is invisible.
 */
async function defaultFindSuitableLead(
  config: OdooConfig,
  partnerId: number,
  serviceInterest: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await json2Call(
    config,
    "crm.lead",
    "search_read",
    {
      domain: [
        ["partner_id", "=", partnerId],
        ["active", "=", true],
        ["name", "ilike", serviceInterest],
      ],
      fields: [...LEAD_READBACK_FIELDS],
      order: "create_date desc",
      limit: 1,
    },
    LEAD_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  return rows && rows.length > 0 ? rows[0] : null
}

async function defaultReadLead(config: OdooConfig, leadId: number): Promise<Record<string, unknown> | null> {
  const rows = (await json2Call(
    config,
    "crm.lead",
    "search_read",
    { domain: [["id", "=", leadId]], fields: [...LEAD_READBACK_FIELDS], limit: 1 },
    LEAD_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  return rows && rows.length > 0 ? rows[0] : null
}

async function defaultCreateLead(config: OdooConfig, vals: Record<string, unknown>): Promise<number | null> {
  const created = (await json2Call(config, "crm.lead", "create", { vals_list: [vals] }, LEAD_TIMEOUT_MS)) as number[] | number
  const id = Array.isArray(created) ? created[0] : created
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null
}

export const DEFAULT_LEAD_CREATE_DEPS: LeadCreateDeps = {
  resolveConfig: resolveOdooConfigForTenant,
  findSuitableLead: defaultFindSuitableLead,
  resolveSourceId: (config, name) => findOrCreateUtmRecord(config, "utm.source", name),
  createLead: defaultCreateLead,
  readLead: defaultReadLead,
  store: prismaOperationStore,
}

function nameOf(v: unknown): string | null {
  return Array.isArray(v) && typeof v[1] === "string" ? v[1] : null
}

function idOf(v: unknown): number | null {
  if (typeof v === "number") return v
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null
}

export function toLeadRecord(row: Record<string, unknown>): LeadRecord {
  return {
    id: typeof row.id === "number" ? row.id : -1,
    name: typeof row.name === "string" ? row.name : "",
    type: typeof row.type === "string" ? row.type : "lead",
    partnerId: idOf(row.partner_id),
    sourceName: nameOf(row.source_id),
    teamId: idOf(row.team_id),
    userId: idOf(row.user_id),
    stage: nameOf(row.stage_id),
    active: row.active !== false,
    createdAt: typeof row.create_date === "string" ? row.create_date : null,
  }
}

/**
 * The lead body. Plain text, bounded, and it names its own provenance: a human
 * opening this record in Odoo can see which conversation produced it without
 * asking anyone.
 */
export function renderLeadDescription(input: LeadCreateInput): string {
  const facts = input.qualificationFacts
    .slice(0, MAX_QUALIFICATION_FACTS)
    .map((f) => `- ${String(f).slice(0, MAX_FACT_CHARS).replace(/[\r\n]+/g, " ").trim()}`)
    .filter((f) => f.length > 2)
  return [
    `Captured by ${ISOLA_LEAD_SOURCE}.`,
    "",
    `Service interest: ${input.serviceInterest}`,
    `Next step: ${input.nextStep}`,
    "",
    facts.length ? "Qualification:" : "Qualification: none captured.",
    ...facts,
    "",
    `Chatwoot conversation: ${input.chatwootConversationId}`,
    `Agent session: ${input.clawithSessionId}`,
    `Correlation: ${input.correlationId}`,
  ].join("\n")
}

function fail(
  operationId: string | null,
  code: LeadCreateFailureCode,
  detail: string,
  leadId?: number,
): LeadCreateResult {
  return { ok: false, tool: LEAD_CREATE_TOOL, operationId, code, detail, ...(leadId ? { leadId } : {}) }
}

function validate(input: LeadCreateInput): LeadCreateFailureCode | null {
  if (!(input.tenantId ?? "").trim()) return "invalid_tenant"
  if (!Number.isInteger(input.partnerId) || input.partnerId <= 0) return "invalid_input"
  if (!(input.serviceInterest ?? "").trim()) return "invalid_input"
  if (!(input.nextStep ?? "").trim()) return "invalid_input"
  if (!(input.chatwootConversationId ?? "").trim()) return "invalid_input"
  if (!(input.clawithSessionId ?? "").trim()) return "invalid_input"
  if (!(input.correlationId ?? "").trim()) return "invalid_input"
  if (!(input.operationIdHint ?? "").trim()) return "invalid_input"
  if (!Array.isArray(input.qualificationFacts)) return "invalid_input"
  if (input.qualificationFacts.length > MAX_QUALIFICATION_FACTS) return "invalid_input"
  if (input.salesTeamId != null && !Number.isInteger(input.salesTeamId)) return "invalid_input"
  if (input.salespersonUserId != null && !Number.isInteger(input.salespersonUserId)) return "invalid_input"
  return null
}

export async function createGovernedLead(
  input: LeadCreateInput,
  policy: LeadCreatePolicy = DEFAULT_LEAD_CREATE_POLICY,
  deps: LeadCreateDeps = DEFAULT_LEAD_CREATE_DEPS,
): Promise<LeadCreateResult> {
  const invalid = validate(input)
  if (invalid) return fail(null, invalid, "governed lead creation input failed validation")
  if (!policy.allowLeadCreation) {
    return fail(null, "lead_creation_not_permitted", "tenant policy disables AI lead creation")
  }

  let config: OdooConfig
  try {
    config = await deps.resolveConfig(input.tenantId)
  } catch (err) {
    return fail(null, "odoo_unavailable", err instanceof Error ? err.message : "tenant Odoo binding could not be resolved")
  }

  // The AUTHORISED arguments - what Foundation accepted, not what was proposed.
  // This is what the ledger hashes, so a hint reused for different arguments is
  // refused rather than served the earlier lead.
  const authorised = {
    partnerId: input.partnerId,
    serviceInterest: input.serviceInterest.trim(),
    nextStep: input.nextStep.trim(),
    qualificationFacts: input.qualificationFacts.map((f) => String(f).trim()),
    salesTeamId: input.salesTeamId ?? null,
    salespersonUserId: input.salespersonUserId ?? null,
    conversationId: input.chatwootConversationId,
  }

  // Courtesy check BEFORE the claim: a lead a human already opened for this
  // customer and service is not ours to duplicate. Never fatal - Odoo being
  // slow here must not block the guarantee below.
  let existing: Record<string, unknown> | null = null
  try {
    existing = await deps.findSuitableLead(config, input.partnerId, authorised.serviceInterest)
  } catch {
    existing = null
  }

  const claim = await claimOperation(
    {
      tenantId: input.tenantId,
      toolName: LEAD_CREATE_TOOL,
      conversationId: input.chatwootConversationId,
      correlationId: input.correlationId,
      agentSessionId: input.clawithSessionId,
      hint: input.operationIdHint,
      authorisedArguments: authorised,
    },
    deps.store,
  )

  if (claim.status === "conflict") {
    return fail(claim.operationId, "operation_conflict", claim.detail)
  }
  if (claim.status === "in_flight") {
    return fail(claim.operationId, "operation_in_flight", "another attempt at this operation is already running")
  }
  if (claim.status === "already_succeeded") {
    const recorded = claim.result as Record<string, unknown> | null
    if (recorded && typeof recorded === "object") {
      return {
        ok: true,
        tool: LEAD_CREATE_TOOL,
        operationId: claim.operationId,
        created: false,
        reused: "recorded_operation",
        lead: toLeadRecord(recorded),
      }
    }
    return fail(claim.operationId, "readback_failed", "operation recorded as succeeded but carries no readback")
  }

  const recordId = claim.recordId
  const operationId = claim.operationId

  // We own the claim from here. Every exit must record an outcome.
  if (existing) {
    const lead = toLeadRecord(existing)
    await completeOperation(recordId, { resultModel: "crm.lead", resultId: lead.id, result: existing }, deps.store)
    return { ok: true, tool: LEAD_CREATE_TOOL, operationId, created: false, reused: "existing_lead", lead }
  }

  let sourceId: number | null = null
  try {
    sourceId = await deps.resolveSourceId(config, ISOLA_LEAD_SOURCE)
  } catch {
    sourceId = null // provenance is recorded in the body too; not worth failing the lead
  }

  const vals: Record<string, unknown> = {
    name: authorised.serviceInterest,
    type: "lead",
    partner_id: input.partnerId,
    contact_name: (input.contactName ?? "").trim() || undefined,
    description: renderLeadDescription(input),
  }
  if (sourceId) vals.source_id = sourceId
  if (input.salesTeamId) vals.team_id = input.salesTeamId
  if (input.salespersonUserId) vals.user_id = input.salespersonUserId
  for (const k of Object.keys(vals)) if (vals[k] === undefined) delete vals[k]

  let leadId: number | null
  try {
    leadId = await deps.createLead(config, vals)
  } catch (err) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "odoo_unavailable", err instanceof Error ? err.message : "crm.lead create failed")
  }
  if (!leadId) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: "create returned no id" }, deps.store)
    return fail(operationId, "odoo_unavailable", "crm.lead create returned no usable id")
  }

  let row: Record<string, unknown> | null
  try {
    row = await deps.readLead(config, leadId)
  } catch (err) {
    await failOperation(recordId, { code: "readback_failed", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "readback_failed", "lead was created but could not be read back", leadId)
  }
  if (!row) {
    await failOperation(recordId, { code: "readback_failed", detail: `lead ${leadId} not readable` }, deps.store)
    return fail(operationId, "readback_failed", "lead was created but could not be read back", leadId)
  }

  const lead = toLeadRecord(row)
  const checks = {
    id_matches: lead.id === leadId,
    partner_matches: lead.partnerId === input.partnerId,
    is_a_lead: lead.type === "lead",
    active: lead.active,
    conversation_recorded:
      typeof row.description === "string" && row.description.includes(input.chatwootConversationId),
    source_recorded: sourceId ? lead.sourceName === ISOLA_LEAD_SOURCE : true,
  }
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
  if (failed.length) {
    await failOperation(recordId, { code: "readback_failed", detail: failed.join(", ") }, deps.store)
    return fail(operationId, "readback_failed", `readback did not match the authorised request: ${failed.join(", ")}`, leadId)
  }

  await completeOperation(recordId, { resultModel: "crm.lead", resultId: lead.id, result: row }, deps.store)
  return { ok: true, tool: LEAD_CREATE_TOOL, operationId, created: true, reused: null, lead }
}
