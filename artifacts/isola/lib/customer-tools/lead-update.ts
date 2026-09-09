/**
 * lead-update.ts - Tool 3 of the governed Foundation customer-tool set.
 *
 * Applies a BOUNDED set of changes to one crm.lead the conversation is entitled
 * to touch, exactly once, and proves each change landed by reading it back.
 *
 * THE ALLOWLIST IS SEMANTIC, NOT A FIELD LIST
 *   Callers ask for `serviceInterest`, `nextStep`, `stageId`, and so on. They
 *   never name an Odoo column. The mapping from intent to column lives here, in
 *   one place, so widening what an agent may change is a reviewable diff rather
 *   than an argument someone passed. There is no passthrough and no "extra
 *   fields" escape hatch, because the first one added is the last one reviewed.
 *
 * OWNERSHIP IS CHECKED, NOT ASSUMED
 *   The target lead must belong to the partner this conversation resolved. A
 *   lead id is guessable and an agent under pressure to be helpful will use the
 *   one it was handed. Without this check, "update my quote" from one customer
 *   could rewrite another customers deal, and every downstream readback would
 *   cheerfully confirm the write succeeded.
 *
 * AND THE INSTANCE IS CHECKED TOO (2026-09-09)
 *   Ownership answers WHOSE record. It never answered WHICH Odoo. The default
 *   resolveConfig is now the WRITE door: a tenant with no OdooBinding row is
 *   refused with `tenant_not_bound` instead of being served the deployment's
 *   own connection, which on the UAT deployment named EPIC's production
 *   instance. Every ownership check below is performed against the instance the
 *   binding names, so the check and the write can no longer disagree about
 *   where they are.
 *
 * STAGE MOVEMENT IS THE SHARP EDGE
 *   A stage id is just an integer, and moving a deal to Won is a commercial
 *   claim, not a data edit. Only stages the TENANT POLICY names as approved for
 *   AI movement are accepted, the stage must belong to this leads own pipeline,
 *   and a record that is already closed is refused outright unless policy
 *   explicitly says otherwise. "It was in the list Odoo returned" is not
 *   authorisation.
 */
import { json2Call } from "@/engines/odoo"
import type { OdooConfig } from "@/engines/odoo"
import { isOdooBindingRequiredError, resolveOdooConfigForTenantWrite } from "@/lib/engine-bindings"
import {
  claimOperation,
  completeOperation,
  failOperation,
  prismaOperationStore,
  type OperationStore,
} from "./operation"

export const LEAD_UPDATE_TOOL = "crm.lead.update"

export const LEAD_UPDATE_FIELDS = [
  "id",
  "name",
  "type",
  "partner_id",
  "stage_id",
  "team_id",
  "user_id",
  "description",
  "active",
  "probability",
  "date_deadline",
  "write_date",
] as const

export const MAX_NOTE_CHARS = 2_000
export const UPDATE_TIMEOUT_MS = 20_000

export type LeadUpdateFailureCode =
  | "invalid_tenant"
  | "invalid_input"
  | "no_approved_changes"
  | "update_not_permitted"
  | "target_not_found"
  | "target_not_owned_by_customer"
  | "target_closed"
  | "stage_not_approved"
  | "assignee_not_approved"
  | "operation_conflict"
  | "operation_in_flight"
  // Odoo was never contacted: this tenant has no system of record. Distinct
  // from `odoo_unavailable`, which means we tried and could not get through.
  | "tenant_not_bound"
  | "odoo_unavailable"
  | "readback_failed"

/** The ONLY things an agent may ask to change. Semantic, never a column name. */
export interface ApprovedLeadChanges {
  serviceInterest?: string
  nextStep?: string
  qualificationFacts?: string[]
  customerNote?: string
  stageId?: number
  salesTeamId?: number
  salespersonUserId?: number
  followUpRequired?: boolean
}

export interface LeadUpdateInput {
  tenantId: string
  leadId: number
  /** The partner this conversation resolved. The lead MUST belong to them. */
  expectedPartnerId: number
  changes: ApprovedLeadChanges
  chatwootConversationId: string
  clawithSessionId: string
  correlationId: string
  operationIdHint: string
}

export interface LeadUpdatePolicy {
  allowUpdates: boolean
  /** Stage ids this tenant permits an AGENT to move a lead into. Empty = none. */
  approvedStageIds: number[]
  /** Sales teams an agent may assign to. Empty = none. */
  approvedSalesTeamIds: number[]
  /** Salespeople an agent may assign to. Empty = none. */
  approvedSalespersonUserIds: number[]
  /** Off by default. A closed deal is a commercial fact, not a stale row. */
  allowClosedRecordUpdates: boolean
}

export const DEFAULT_LEAD_UPDATE_POLICY: LeadUpdatePolicy = {
  allowUpdates: true,
  approvedStageIds: [],
  approvedSalesTeamIds: [],
  approvedSalespersonUserIds: [],
  allowClosedRecordUpdates: false,
}

export interface LeadUpdateDeps {
  resolveConfig: (tenantId: string) => Promise<OdooConfig>
  readLead: (config: OdooConfig, leadId: number) => Promise<Record<string, unknown> | null>
  readPipelineStageIds: (config: OdooConfig, teamId: number | null) => Promise<number[]>
  writeLead: (config: OdooConfig, leadId: number, vals: Record<string, unknown>) => Promise<void>
  store: OperationStore
}

async function defaultReadLead(config: OdooConfig, leadId: number): Promise<Record<string, unknown> | null> {
  const rows = (await json2Call(
    config,
    "crm.lead",
    "search_read",
    { domain: [["id", "=", leadId]], fields: [...LEAD_UPDATE_FIELDS], limit: 1 },
    UPDATE_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  return rows && rows.length > 0 ? rows[0] : null
}

/**
 * The stage ids that actually exist on this leads own pipeline.
 *
 * Odoo crm.stage rows with no team are shared across every pipeline; rows with
 * a team belong to that one. A stage borrowed from another team silently moves
 * the deal onto a board nobody is watching.
 */
async function defaultReadPipelineStageIds(config: OdooConfig, teamId: number | null): Promise<number[]> {
  const rows = (await json2Call(
    config,
    "crm.stage",
    "search_read",
    {
      domain: teamId ? ["|", ["team_id", "=", false], ["team_id", "=", teamId]] : [["team_id", "=", false]],
      fields: ["id"],
      limit: 100,
    },
    UPDATE_TIMEOUT_MS,
  )) as { id: number }[]
  return (rows ?? []).map((r) => r.id)
}

async function defaultWriteLead(config: OdooConfig, leadId: number, vals: Record<string, unknown>): Promise<void> {
  await json2Call(config, "crm.lead", "write", { ids: [leadId], vals }, UPDATE_TIMEOUT_MS)
}

export const DEFAULT_LEAD_UPDATE_DEPS: LeadUpdateDeps = {
  // THE WRITE DOOR, not the read resolver. See the module header.
  resolveConfig: resolveOdooConfigForTenantWrite,
  readLead: defaultReadLead,
  readPipelineStageIds: defaultReadPipelineStageIds,
  writeLead: defaultWriteLead,
  store: prismaOperationStore,
}

export interface LeadUpdateApplied {
  leadId: number
  changedKeys: string[]
  stage: string | null
  teamId: number | null
  userId: number | null
  name: string
  updatedAt: string | null
}

export type LeadUpdateResult =
  | { ok: true; tool: typeof LEAD_UPDATE_TOOL; operationId: string; applied: LeadUpdateApplied; reused: "recorded_operation" | null }
  | { ok: false; tool: typeof LEAD_UPDATE_TOOL; operationId: string | null; code: LeadUpdateFailureCode; detail: string }

function idOf(v: unknown): number | null {
  if (typeof v === "number") return v
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null
}

function nameOf(v: unknown): string | null {
  return Array.isArray(v) && typeof v[1] === "string" ? v[1] : null
}

function flatten(v: string, max: number): string {
  return v.replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max)
}

function fail(operationId: string | null, code: LeadUpdateFailureCode, detail: string): LeadUpdateResult {
  return { ok: false, tool: LEAD_UPDATE_TOOL, operationId, code, detail }
}

/**
 * A lead is CLOSED when Odoo has archived it or resolved its probability to a
 * terminal value. Either way the commercial outcome has been recorded by a
 * human, and an agent quietly editing it afterwards rewrites history.
 */
export function isClosedLead(row: Record<string, unknown>): boolean {
  if (row.active === false) return true
  const p = row.probability
  return typeof p === "number" && (p === 0 || p === 100)
}

/** Normalise the requested changes into the AUTHORISED set. Unknown keys never survive. */
export function normaliseChanges(changes: ApprovedLeadChanges): ApprovedLeadChanges {
  const out: ApprovedLeadChanges = {}
  if (typeof changes.serviceInterest === "string" && changes.serviceInterest.trim()) {
    out.serviceInterest = flatten(changes.serviceInterest, 200)
  }
  if (typeof changes.nextStep === "string" && changes.nextStep.trim()) {
    out.nextStep = flatten(changes.nextStep, 300)
  }
  if (Array.isArray(changes.qualificationFacts)) {
    const facts = changes.qualificationFacts
      .slice(0, 20)
      .map((f) => flatten(String(f), 500))
      .filter(Boolean)
    if (facts.length) out.qualificationFacts = facts
  }
  if (typeof changes.customerNote === "string" && changes.customerNote.trim()) {
    out.customerNote = flatten(changes.customerNote, MAX_NOTE_CHARS)
  }
  if (Number.isInteger(changes.stageId) && (changes.stageId as number) > 0) out.stageId = changes.stageId
  if (Number.isInteger(changes.salesTeamId) && (changes.salesTeamId as number) > 0) out.salesTeamId = changes.salesTeamId
  if (Number.isInteger(changes.salespersonUserId) && (changes.salespersonUserId as number) > 0) {
    out.salespersonUserId = changes.salespersonUserId
  }
  if (typeof changes.followUpRequired === "boolean") out.followUpRequired = changes.followUpRequired
  return out
}

/** The appended block. Existing description text is never rewritten, only extended. */
export function renderUpdateBlock(changes: ApprovedLeadChanges, input: LeadUpdateInput): string {
  const lines = ["", "--- Updated by WhatsApp / Isola AI ---"]
  if (changes.nextStep) lines.push(`Next step: ${changes.nextStep}`)
  if (changes.followUpRequired !== undefined) lines.push(`Follow-up required: ${changes.followUpRequired ? "yes" : "no"}`)
  if (changes.customerNote) lines.push(`Customer said: ${changes.customerNote}`)
  for (const f of changes.qualificationFacts ?? []) lines.push(`- ${f}`)
  lines.push(`Chatwoot conversation: ${input.chatwootConversationId}`)
  lines.push(`Correlation: ${input.correlationId}`)
  return lines.join("\n")
}

export async function updateGovernedLead(
  input: LeadUpdateInput,
  policy: LeadUpdatePolicy = DEFAULT_LEAD_UPDATE_POLICY,
  deps: LeadUpdateDeps = DEFAULT_LEAD_UPDATE_DEPS,
): Promise<LeadUpdateResult> {
  if (!(input.tenantId ?? "").trim()) return fail(null, "invalid_tenant", "tenantId is required")
  if (!Number.isInteger(input.leadId) || input.leadId <= 0) return fail(null, "invalid_input", "leadId is required")
  if (!Number.isInteger(input.expectedPartnerId) || input.expectedPartnerId <= 0) {
    return fail(null, "invalid_input", "expectedPartnerId is required - ownership is checked, not assumed")
  }
  for (const [k, v] of [
    ["chatwootConversationId", input.chatwootConversationId],
    ["clawithSessionId", input.clawithSessionId],
    ["correlationId", input.correlationId],
    ["operationIdHint", input.operationIdHint],
  ] as const) {
    if (typeof v !== "string" || !v.trim()) return fail(null, "invalid_input", `${k} is required`)
  }
  if (!policy.allowUpdates) return fail(null, "update_not_permitted", "tenant policy disables AI lead updates")

  const changes = normaliseChanges(input.changes ?? {})
  if (Object.keys(changes).length === 0) {
    return fail(null, "no_approved_changes", "nothing in the request maps to an approved change")
  }

  let config: OdooConfig
  try {
    config = await deps.resolveConfig(input.tenantId)
  } catch (err) {
    // Nothing was contacted and nothing was written. A retry cannot help; a
    // binding row can.
    if (isOdooBindingRequiredError(err)) {
      return fail(
        null,
        "tenant_not_bound",
        "this tenant is not bound to an Odoo instance, so there is no lead here to update",
      )
    }
    return fail(null, "odoo_unavailable", err instanceof Error ? err.message : "tenant Odoo binding could not be resolved")
  }

  // ---- Target validation, all BEFORE the claim so a refusal costs nothing.
  let before: Record<string, unknown> | null
  try {
    before = await deps.readLead(config, input.leadId)
  } catch (err) {
    return fail(null, "odoo_unavailable", err instanceof Error ? err.message : "crm.lead read failed")
  }
  if (!before) return fail(null, "target_not_found", `crm.lead ${input.leadId} does not exist on this tenant`)

  if (idOf(before.partner_id) !== input.expectedPartnerId) {
    return fail(
      null,
      "target_not_owned_by_customer",
      "the lead does not belong to the customer this conversation resolved",
    )
  }
  if (isClosedLead(before) && !policy.allowClosedRecordUpdates) {
    return fail(null, "target_closed", "the lead is closed - a recorded commercial outcome is not an agent edit")
  }

  if (changes.stageId !== undefined) {
    if (!policy.approvedStageIds.includes(changes.stageId)) {
      return fail(null, "stage_not_approved", `stage ${changes.stageId} is not approved for agent movement on this tenant`)
    }
    let pipeline: number[]
    try {
      pipeline = await deps.readPipelineStageIds(config, idOf(before.team_id))
    } catch (err) {
      return fail(null, "odoo_unavailable", err instanceof Error ? err.message : "crm.stage read failed")
    }
    if (!pipeline.includes(changes.stageId)) {
      return fail(null, "stage_not_approved", `stage ${changes.stageId} is not on this lead own pipeline`)
    }
  }
  if (changes.salesTeamId !== undefined && !policy.approvedSalesTeamIds.includes(changes.salesTeamId)) {
    return fail(null, "assignee_not_approved", `sales team ${changes.salesTeamId} is not approved for agent assignment`)
  }
  if (changes.salespersonUserId !== undefined && !policy.approvedSalespersonUserIds.includes(changes.salespersonUserId)) {
    return fail(null, "assignee_not_approved", `salesperson ${changes.salespersonUserId} is not approved for agent assignment`)
  }

  // ---- Claim.
  const claim = await claimOperation(
    {
      tenantId: input.tenantId,
      toolName: LEAD_UPDATE_TOOL,
      conversationId: input.chatwootConversationId,
      correlationId: input.correlationId,
      agentSessionId: input.clawithSessionId,
      hint: input.operationIdHint,
      authorisedArguments: { leadId: input.leadId, partnerId: input.expectedPartnerId, changes },
    },
    deps.store,
  )
  if (claim.status === "conflict") return fail(claim.operationId, "operation_conflict", claim.detail)
  if (claim.status === "in_flight") {
    return fail(claim.operationId, "operation_in_flight", "another attempt at this operation is already running")
  }
  if (claim.status === "already_succeeded") {
    const recorded = claim.result as LeadUpdateApplied | null
    if (recorded && typeof recorded === "object") {
      return { ok: true, tool: LEAD_UPDATE_TOOL, operationId: claim.operationId, applied: recorded, reused: "recorded_operation" }
    }
    return fail(claim.operationId, "readback_failed", "operation recorded as succeeded but carries no readback")
  }

  const recordId = claim.recordId
  const operationId = claim.operationId

  // ---- Build the write. Only mapped columns; nothing else can reach Odoo.
  const vals: Record<string, unknown> = {}
  if (changes.serviceInterest) vals.name = changes.serviceInterest
  if (changes.stageId !== undefined) vals.stage_id = changes.stageId
  if (changes.salesTeamId !== undefined) vals.team_id = changes.salesTeamId
  if (changes.salespersonUserId !== undefined) vals.user_id = changes.salespersonUserId
  const narrative =
    changes.nextStep || changes.customerNote || changes.qualificationFacts || changes.followUpRequired !== undefined
  if (narrative) {
    const existing = typeof before.description === "string" ? before.description : ""
    vals.description = existing + renderUpdateBlock(changes, input)
  }

  try {
    await deps.writeLead(config, input.leadId, vals)
  } catch (err) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "odoo_unavailable", err instanceof Error ? err.message : "crm.lead write failed")
  }

  let after: Record<string, unknown> | null
  try {
    after = await deps.readLead(config, input.leadId)
  } catch (err) {
    await failOperation(recordId, { code: "readback_failed", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "readback_failed", "the write was issued but the lead could not be read back")
  }
  if (!after) {
    await failOperation(recordId, { code: "readback_failed", detail: "lead not readable after write" }, deps.store)
    return fail(operationId, "readback_failed", "the write was issued but the lead could not be read back")
  }

  // Every requested change is verified INDIVIDUALLY. A write that reported no
  // error while silently dropping one field is the failure mode this catches.
  const verified: Record<string, boolean> = {}
  if (changes.serviceInterest) verified.serviceInterest = after.name === changes.serviceInterest
  if (changes.stageId !== undefined) verified.stageId = idOf(after.stage_id) === changes.stageId
  if (changes.salesTeamId !== undefined) verified.salesTeamId = idOf(after.team_id) === changes.salesTeamId
  if (changes.salespersonUserId !== undefined) verified.salespersonUserId = idOf(after.user_id) === changes.salespersonUserId
  if (narrative) {
    verified.narrative =
      typeof after.description === "string" && after.description.includes(input.correlationId)
  }
  verified.partnerUnchanged = idOf(after.partner_id) === input.expectedPartnerId

  const notApplied = Object.entries(verified).filter(([, v]) => v !== true).map(([k]) => k)
  if (notApplied.length) {
    await failOperation(recordId, { code: "readback_failed", detail: notApplied.join(", ") }, deps.store)
    return fail(operationId, "readback_failed", `these changes did not land: ${notApplied.join(", ")}`)
  }

  const applied: LeadUpdateApplied = {
    leadId: input.leadId,
    changedKeys: Object.keys(changes),
    stage: nameOf(after.stage_id),
    teamId: idOf(after.team_id),
    userId: idOf(after.user_id),
    name: typeof after.name === "string" ? after.name : "",
    updatedAt: typeof after.write_date === "string" ? after.write_date : null,
  }
  await completeOperation(recordId, { resultModel: "crm.lead", resultId: input.leadId, result: applied }, deps.store)
  return { ok: true, tool: LEAD_UPDATE_TOOL, operationId, applied, reused: null }
}
