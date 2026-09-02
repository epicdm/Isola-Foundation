/**
 * follow-up.ts - Tool 4 of the governed Foundation customer-tool set.
 *
 * Creates ONE durable mail.activity - a follow-up a human will actually see in
 * Odoo - for a record the conversation is entitled to touch.
 *
 * WHY THIS DOES NOT CALL THE STAFF-OPS RESOLVERS
 *   `resolveVerificationModelId` and `resolveVerificationActivityType` in
 *   lib/staff-ops/odoo-work.ts do exactly the right thing, and they are gated
 *   by `isVerificationTargetModel` - the MANAGER-VERIFICATION allowlist
 *   (project.task and friends). Customer follow-ups hang off crm.lead and
 *   res.partner. The tempting move is to widen that allowlist so both paths
 *   share one function. That would weaken manager verification: the allowlist
 *   is what stops a verification activity being created against an arbitrary
 *   model, and it must keep meaning exactly what it means today. So the SHAPE
 *   is reused - allowlist first, resolve ids from Odoo, never accept a
 *   caller-supplied id - and the allowlist itself is separate and narrower.
 *
 * THE PROPERTY THAT MATTERS MOST
 *   A retry after the activity has been COMPLETED or UNLINKED must not create a
 *   second follow-up. Odoo cannot help here: a done mail.activity is gone from
 *   the searchable set, so any "check whether one already exists" strategy
 *   silently creates a duplicate the moment the customer replies again. The
 *   ledger is durable and independent of the Odoo records lifecycle, and on a
 *   repeat this tool returns the RECORDED result without reading Odoo at all -
 *   deliberately, because reading would only tempt it to recreate.
 */
import { json2Call } from "@/engines/odoo"
import type { OdooConfig } from "@/engines/odoo"
import { resolveOdooConfigForTenant } from "@/lib/engine-bindings"
import {
  claimOperation,
  completeOperation,
  failOperation,
  prismaOperationStore,
  type OperationStore,
} from "./operation"

export const FOLLOW_UP_TOOL = "crm.followup.create"

/**
 * The ONLY models a customer follow-up may hang off.
 *
 * Deliberately NOT the manager-verification allowlist and deliberately not a
 * superset of it. Two allowlists that mean different things should be two
 * allowlists.
 */
export const FOLLOW_UP_TARGET_MODELS = ["crm.lead", "res.partner"] as const
export type FollowUpTargetModel = (typeof FOLLOW_UP_TARGET_MODELS)[number]

export function isFollowUpTargetModel(v: unknown): v is FollowUpTargetModel {
  return typeof v === "string" && (FOLLOW_UP_TARGET_MODELS as readonly string[]).includes(v)
}

/** Activity-type names this tool will accept, in preference order. */
export const FOLLOW_UP_TYPE_NAMES = ["To-Do", "To Do", "Todo"] as const

export const MAX_PURPOSE_CHARS = 500
export const FOLLOW_UP_TIMEOUT_MS = 20_000

export type FollowUpFailureCode =
  | "invalid_tenant"
  | "invalid_input"
  | "model_not_allowlisted"
  | "target_not_found"
  | "target_not_owned_by_customer"
  | "assignee_not_authorized"
  | "activity_type_unresolved"
  | "res_model_id_unresolved"
  | "follow_up_not_permitted"
  | "operation_conflict"
  | "operation_in_flight"
  | "odoo_unavailable"
  | "readback_failed"

export interface FollowUpInput {
  tenantId: string
  targetModel: string
  targetId: number
  /** The partner this conversation resolved. The target must belong to them. */
  expectedPartnerId: number
  /** Odoo res.users id the follow-up is assigned to. Must be policy-approved. */
  assigneeUserId: number
  /** Why a human needs to act. Shown as the activity summary. */
  purpose: string
  /** YYYY-MM-DD. Required - mail.activity has no meaningful default. */
  deadline: string
  chatwootConversationId: string
  clawithSessionId: string
  correlationId: string
  operationIdHint: string
  /** The lead or opportunity this follow-up is about, when there is one. */
  leadReference?: number | null
}

export interface FollowUpPolicy {
  allowFollowUps: boolean
  /** res.users ids an agent may assign work to. Empty = none. */
  approvedAssigneeUserIds: number[]
  /** Optional tenant override for the activity type. */
  activityTypeXmlId?: string | null
  activityTypeId?: number | null
}

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = {
  allowFollowUps: true,
  approvedAssigneeUserIds: [],
}

export interface FollowUpRecord {
  activityId: number
  resModel: string
  resModelId: number
  resId: number
  assigneeUserId: number | null
  activityTypeId: number | null
  activityTypeName: string | null
  summary: string | null
  deadline: string | null
}

export type FollowUpResult =
  | { ok: true; tool: typeof FOLLOW_UP_TOOL; operationId: string; created: boolean; followUp: FollowUpRecord }
  | { ok: false; tool: typeof FOLLOW_UP_TOOL; operationId: string | null; code: FollowUpFailureCode; detail: string; activityId?: number }

export interface FollowUpDeps {
  resolveConfig: (tenantId: string) => Promise<OdooConfig>
  /** ir.model lookup. Allowlist is checked BEFORE this is called. */
  resolveResModelId: (config: OdooConfig, model: FollowUpTargetModel) => Promise<number | null>
  /** Runtime activity-type resolution. Never a hardcoded id. */
  resolveActivityType: (
    config: OdooConfig,
    model: FollowUpTargetModel,
    policy: FollowUpPolicy,
  ) => Promise<{ activityTypeId: number; name: string } | null>
  /** Reads the target and returns the partner it belongs to, or null. */
  readTargetPartnerId: (config: OdooConfig, model: FollowUpTargetModel, id: number) => Promise<number | null>
  createActivity: (config: OdooConfig, vals: Record<string, unknown>) => Promise<number | null>
  readActivity: (config: OdooConfig, activityId: number) => Promise<Record<string, unknown> | null>
  store: OperationStore
}

async function defaultResolveResModelId(config: OdooConfig, model: FollowUpTargetModel): Promise<number | null> {
  const rows = (await json2Call(
    config,
    "ir.model",
    "search_read",
    { domain: [["model", "=", model]], fields: ["id", "model"], limit: 1 },
    FOLLOW_UP_TIMEOUT_MS,
  ).catch(() => [])) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row || String(row.model ?? "") !== model) return null
  const id = Number(row.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Resolve the activity type at runtime.
 *
 * A type carrying its own `res_model` is scoped to that model. A generic type
 * (`res_model: false`) is valid anywhere. Anything scoped to a DIFFERENT model
 * is refused - an activity of type "Time Off Approval" on a crm.lead is a
 * nonsense record that a human will have to clean up by hand.
 */
async function defaultResolveActivityType(
  config: OdooConfig,
  model: FollowUpTargetModel,
  policy: FollowUpPolicy,
): Promise<{ activityTypeId: number; name: string } | null> {
  const usable = (row: Record<string, unknown> | undefined): { activityTypeId: number; name: string } | null => {
    if (!row) return null
    const id = Number(row.id)
    if (!Number.isInteger(id) || id <= 0) return null
    const scope = row.res_model
    if (typeof scope === "string" && scope.length > 0 && scope !== model) return null
    return { activityTypeId: id, name: String(row.name ?? "") }
  }

  const xmlId = (policy.activityTypeXmlId ?? "").trim()
  if (xmlId) {
    const [module, name] = xmlId.split(".")
    const data = (await json2Call(
      config,
      "ir.model.data",
      "search_read",
      {
        domain: [["module", "=", module], ["name", "=", name], ["model", "=", "mail.activity.type"]],
        fields: ["res_id"],
        limit: 1,
      },
      FOLLOW_UP_TIMEOUT_MS,
    ).catch(() => [])) as Record<string, unknown>[]
    const resId = Number(data?.[0]?.res_id)
    if (Number.isInteger(resId) && resId > 0) {
      const rows = (await json2Call(
        config, "mail.activity.type", "search_read",
        { domain: [["id", "=", resId]], fields: ["id", "name", "res_model"], limit: 1 },
        FOLLOW_UP_TIMEOUT_MS,
      ).catch(() => [])) as Record<string, unknown>[]
      const hit = usable(rows?.[0])
      if (hit) return hit
    }
  }

  if (Number.isInteger(policy.activityTypeId) && (policy.activityTypeId as number) > 0) {
    const rows = (await json2Call(
      config, "mail.activity.type", "search_read",
      { domain: [["id", "=", policy.activityTypeId]], fields: ["id", "name", "res_model"], limit: 1 },
      FOLLOW_UP_TIMEOUT_MS,
    ).catch(() => [])) as Record<string, unknown>[]
    const hit = usable(rows?.[0])
    if (hit) return hit
  }

  const rows = (await json2Call(
    config, "mail.activity.type", "search_read",
    { domain: [["name", "in", [...FOLLOW_UP_TYPE_NAMES]]], fields: ["id", "name", "res_model"], limit: 10 },
    FOLLOW_UP_TIMEOUT_MS,
  ).catch(() => [])) as Record<string, unknown>[]
  for (const wanted of FOLLOW_UP_TYPE_NAMES) {
    const hit = usable((rows ?? []).find((r) => String(r.name ?? "") === wanted))
    if (hit) return hit
  }
  return null
}

async function defaultReadTargetPartnerId(
  config: OdooConfig,
  model: FollowUpTargetModel,
  id: number,
): Promise<number | null> {
  const fields = model === "res.partner" ? ["id"] : ["id", "partner_id"]
  const rows = (await json2Call(
    config, model, "search_read",
    { domain: [["id", "=", id]], fields, limit: 1 },
    FOLLOW_UP_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row) return null
  if (model === "res.partner") return Number(row.id)
  const p = row.partner_id
  if (typeof p === "number") return p
  return Array.isArray(p) && typeof p[0] === "number" ? p[0] : null
}

async function defaultCreateActivity(config: OdooConfig, vals: Record<string, unknown>): Promise<number | null> {
  const created = (await json2Call(config, "mail.activity", "create", { vals_list: [vals] }, FOLLOW_UP_TIMEOUT_MS)) as number[] | number
  const id = Array.isArray(created) ? created[0] : created
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null
}

async function defaultReadActivity(config: OdooConfig, activityId: number): Promise<Record<string, unknown> | null> {
  const rows = (await json2Call(
    config, "mail.activity", "search_read",
    {
      domain: [["id", "=", activityId]],
      fields: ["id", "res_model", "res_model_id", "res_id", "user_id", "activity_type_id", "summary", "date_deadline"],
      limit: 1,
    },
    FOLLOW_UP_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  return rows && rows.length > 0 ? rows[0] : null
}

export const DEFAULT_FOLLOW_UP_DEPS: FollowUpDeps = {
  resolveConfig: resolveOdooConfigForTenant,
  resolveResModelId: defaultResolveResModelId,
  resolveActivityType: defaultResolveActivityType,
  readTargetPartnerId: defaultReadTargetPartnerId,
  createActivity: defaultCreateActivity,
  readActivity: defaultReadActivity,
  store: prismaOperationStore,
}

function idOf(v: unknown): number | null {
  if (typeof v === "number") return v
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null
}

function nameOf(v: unknown): string | null {
  return Array.isArray(v) && typeof v[1] === "string" ? v[1] : null
}

function fail(operationId: string | null, code: FollowUpFailureCode, detail: string, activityId?: number): FollowUpResult {
  return { ok: false, tool: FOLLOW_UP_TOOL, operationId, code, detail, ...(activityId ? { activityId } : {}) }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function renderFollowUpNote(input: FollowUpInput): string {
  return [
    `Raised by WhatsApp / Isola AI.`,
    `Purpose: ${input.purpose}`,
    input.leadReference ? `Lead / opportunity: crm.lead#${input.leadReference}` : "Lead / opportunity: none referenced",
    `Chatwoot conversation: ${input.chatwootConversationId}`,
    `Agent session: ${input.clawithSessionId}`,
    `Correlation: ${input.correlationId}`,
  ].join("\n")
}

export async function createGovernedFollowUp(
  input: FollowUpInput,
  policy: FollowUpPolicy = DEFAULT_FOLLOW_UP_POLICY,
  deps: FollowUpDeps = DEFAULT_FOLLOW_UP_DEPS,
): Promise<FollowUpResult> {
  if (!(input.tenantId ?? "").trim()) return fail(null, "invalid_tenant", "tenantId is required")
  if (!isFollowUpTargetModel(input.targetModel)) {
    return fail(null, "model_not_allowlisted", `${String(input.targetModel)} is not a follow-up target model`)
  }
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) return fail(null, "invalid_input", "targetId is required")
  if (!Number.isInteger(input.expectedPartnerId) || input.expectedPartnerId <= 0) {
    return fail(null, "invalid_input", "expectedPartnerId is required - ownership is checked, not assumed")
  }
  if (!Number.isInteger(input.assigneeUserId) || input.assigneeUserId <= 0) {
    return fail(null, "invalid_input", "assigneeUserId is required")
  }
  if (!(input.purpose ?? "").trim()) return fail(null, "invalid_input", "purpose is required")
  if (!ISO_DATE.test(input.deadline ?? "")) {
    return fail(null, "invalid_input", "deadline must be YYYY-MM-DD - mail.activity has no meaningful default")
  }
  for (const [k, v] of [
    ["chatwootConversationId", input.chatwootConversationId],
    ["clawithSessionId", input.clawithSessionId],
    ["correlationId", input.correlationId],
    ["operationIdHint", input.operationIdHint],
  ] as const) {
    if (typeof v !== "string" || !v.trim()) return fail(null, "invalid_input", `${k} is required`)
  }
  if (!policy.allowFollowUps) return fail(null, "follow_up_not_permitted", "tenant policy disables AI follow-ups")
  if (!policy.approvedAssigneeUserIds.includes(input.assigneeUserId)) {
    return fail(null, "assignee_not_authorized", `res.users ${input.assigneeUserId} is not approved to receive agent follow-ups`)
  }

  const model = input.targetModel as FollowUpTargetModel
  const purpose = input.purpose.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_PURPOSE_CHARS)

  // The claim comes FIRST for this tool. Every other governed tool can afford
  // to validate against Odoo before claiming, because a refusal leaves nothing
  // behind. Here the retry-after-completion case is the whole point: if we read
  // Odoo first on a repeat we would find no activity and be tempted to create a
  // second one. The recorded operation answers before Odoo is ever consulted.
  const claim = await claimOperation(
    {
      tenantId: input.tenantId,
      toolName: FOLLOW_UP_TOOL,
      conversationId: input.chatwootConversationId,
      correlationId: input.correlationId,
      agentSessionId: input.clawithSessionId,
      hint: input.operationIdHint,
      authorisedArguments: {
        targetModel: model,
        targetId: input.targetId,
        partnerId: input.expectedPartnerId,
        assigneeUserId: input.assigneeUserId,
        purpose,
        deadline: input.deadline,
        leadReference: input.leadReference ?? null,
      },
    },
    deps.store,
  )
  if (claim.status === "conflict") return fail(claim.operationId, "operation_conflict", claim.detail)
  if (claim.status === "in_flight") {
    return fail(claim.operationId, "operation_in_flight", "another attempt at this operation is already running")
  }
  if (claim.status === "already_succeeded") {
    const recorded = claim.result as FollowUpRecord | null
    if (recorded && typeof recorded === "object") {
      // Odoo is deliberately NOT consulted here. The activity may since have
      // been completed or unlinked, and that must not produce a second one.
      return { ok: true, tool: FOLLOW_UP_TOOL, operationId: claim.operationId, created: false, followUp: recorded }
    }
    return fail(claim.operationId, "readback_failed", "operation recorded as succeeded but carries no readback")
  }

  const recordId = claim.recordId
  const operationId = claim.operationId

  let config: OdooConfig
  try {
    config = await deps.resolveConfig(input.tenantId)
  } catch (err) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "odoo_unavailable", "tenant Odoo binding could not be resolved")
  }

  try {
    const owner = await deps.readTargetPartnerId(config, model, input.targetId)
    if (owner === null) {
      await failOperation(recordId, { code: "target_not_found", detail: `${model} ${input.targetId}` }, deps.store)
      return fail(operationId, "target_not_found", `${model} ${input.targetId} does not exist on this tenant`)
    }
    if (owner !== input.expectedPartnerId) {
      await failOperation(recordId, { code: "target_not_owned_by_customer", detail: `${model} ${input.targetId}` }, deps.store)
      return fail(operationId, "target_not_owned_by_customer", "the target does not belong to the customer this conversation resolved")
    }
  } catch (err) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "odoo_unavailable", "target ownership could not be verified")
  }

  const resModelId = await deps.resolveResModelId(config, model)
  if (!resModelId) {
    await failOperation(recordId, { code: "res_model_id_unresolved", detail: model }, deps.store)
    return fail(operationId, "res_model_id_unresolved", `ir.model id for ${model} could not be resolved`)
  }

  const activityType = await deps.resolveActivityType(config, model, policy)
  if (!activityType) {
    await failOperation(recordId, { code: "activity_type_unresolved", detail: model }, deps.store)
    return fail(operationId, "activity_type_unresolved", "no usable mail.activity.type resolved - refusing to guess an id")
  }

  // res_model is READONLY and related to res_model_id on this Odoo. Writing it
  // is the exact defect that made manager verification fail for a day. Only
  // resolved ids go in.
  const vals = {
    res_model_id: resModelId,
    res_id: input.targetId,
    activity_type_id: activityType.activityTypeId,
    user_id: input.assigneeUserId,
    summary: purpose,
    note: renderFollowUpNote(input),
    date_deadline: input.deadline,
  }

  let activityId: number | null
  try {
    activityId = await deps.createActivity(config, vals)
  } catch (err) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null }, deps.store)
    return fail(operationId, "odoo_unavailable", err instanceof Error ? err.message : "mail.activity create failed")
  }
  if (!activityId) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: "create returned no id" }, deps.store)
    return fail(operationId, "odoo_unavailable", "mail.activity create returned no usable id")
  }

  let row: Record<string, unknown> | null
  try {
    row = await deps.readActivity(config, activityId)
  } catch {
    row = null
  }
  if (!row) {
    await failOperation(recordId, { code: "readback_failed", detail: `activity ${activityId}` }, deps.store)
    return fail(operationId, "readback_failed", "the activity was created but could not be read back", activityId)
  }

  const followUp: FollowUpRecord = {
    activityId,
    resModel: typeof row.res_model === "string" ? row.res_model : model,
    resModelId: idOf(row.res_model_id) ?? resModelId,
    resId: typeof row.res_id === "number" ? row.res_id : input.targetId,
    assigneeUserId: idOf(row.user_id),
    activityTypeId: idOf(row.activity_type_id),
    activityTypeName: nameOf(row.activity_type_id) ?? activityType.name,
    summary: typeof row.summary === "string" ? row.summary : null,
    deadline: typeof row.date_deadline === "string" ? row.date_deadline : null,
  }

  const checks = {
    hangs_on_the_right_record: followUp.resId === input.targetId && followUp.resModel === model,
    res_model_id_stored: followUp.resModelId === resModelId,
    assigned_to_the_authorized_user: followUp.assigneeUserId === input.assigneeUserId,
    type_stored: followUp.activityTypeId === activityType.activityTypeId,
    deadline_stored: followUp.deadline === input.deadline,
  }
  const bad = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
  if (bad.length) {
    await failOperation(recordId, { code: "readback_failed", detail: bad.join(", ") }, deps.store)
    return fail(operationId, "readback_failed", `activity readback did not match: ${bad.join(", ")}`, activityId)
  }

  await completeOperation(recordId, { resultModel: "mail.activity", resultId: activityId, result: followUp }, deps.store)
  return { ok: true, tool: FOLLOW_UP_TOOL, operationId, created: true, followUp }
}
