/**
 * business-note.ts - Tool 5 of the governed Foundation customer-tool set.
 *
 * Posts ONE chatter note (`message_post`) recording what the customer asked
 * for, what the AI did, what came of it and what happens next - against a
 * record the conversation is entitled to touch, exactly once.
 *
 * WHY THIS DOES NOT REUSE THE STAFF-OPS NOTE WRITER
 *   `postStaffActionNote` in lib/staff-ops/odoo-work.ts posts a chatter note
 *   too, and its `escapeHtml` helper is private to that module. Both facts are
 *   deliberate and stay that way. That module is the manager-verification path,
 *   repaired in production this week; widening its exports to serve a
 *   customer-facing caller would put a second class of caller behind functions
 *   whose narrowness is the safety property. So the SHAPE is reused - allowlist
 *   first, ownership proven, resolved ids only, readback before success - and
 *   the sanitiser here is separate because it must do strictly more than
 *   escaping (see below).
 *
 * WHY SANITISATION IS NOT COSMETIC
 *   Odoo chatter renders its body as HTML. The text arriving here originated in
 *   a WhatsApp message from a member of the public and passed through a language
 *   model, which means it is attacker-influenced twice over. An unsanitised note
 *   is stored XSS pointed at our own staff, in the tool they use all day. Tags
 *   are stripped and what remains is escaped, so nothing in the note can
 *   reconstruct markup.
 *
 * WHY A SECRET-SHAPED NOTE IS REFUSED RATHER THAN REDACTED
 *   Customers paste things. A bearer token, an API key or a private key pasted
 *   into WhatsApp and then mirrored into the CRM is permanent, replicated to
 *   every Odoo backup, and visible to everyone with chatter access. Redacting
 *   silently would still record that a secret was present, still risk a partial
 *   leak through an imperfect pattern, and - worst - would let the agent believe
 *   the note it composed is what was stored. So the whole note is refused with
 *   its own code (`secret_shaped_content`) and the caller has to deal with it.
 *
 * THE PROPERTY THAT MATTERS MOST
 *   A retry must not post a second note. As with Tool 4, Odoo cannot be asked
 *   "did you already get this" - a chatter message can be deleted by any user
 *   with the rights, and the searchable set is not a durable answer. The ledger
 *   is, so on a repeat this tool returns the RECORDED result and does not read
 *   Odoo at all.
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

export const BUSINESS_NOTE_TOOL = "crm.note.create"

/**
 * The ONLY models a customer business note may be posted against.
 *
 * Its own list. Not Tool 4's - which happens to hold the same two entries today
 * and must be free to change without dragging this tool along - and emphatically
 * not the staff `isVerificationTargetModel` allowlist, whose narrowness is what
 * keeps manager verification meaning what it means.
 */
export const BUSINESS_NOTE_TARGET_MODELS = ["crm.lead", "res.partner"] as const
export type BusinessNoteTargetModel = (typeof BUSINESS_NOTE_TARGET_MODELS)[number]

export function isBusinessNoteTargetModel(v: unknown): v is BusinessNoteTargetModel {
  return typeof v === "string" && (BUSINESS_NOTE_TARGET_MODELS as readonly string[]).includes(v)
}

/** Per-section bound. Four sections, so the posted body stays comfortably small. */
export const MAX_NOTE_SECTION_CHARS = 600
/** Belt-and-braces bound on the assembled HTML body. */
export const MAX_NOTE_BODY_CHARS = 4_000
export const BUSINESS_NOTE_TIMEOUT_MS = 20_000

/** Correlation ids are interpolated into the note body and then asserted on the
 *  readback. Constraining the charset keeps them from being an injection vector
 *  and keeps the readback comparison exact rather than escaping-dependent. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/

export type BusinessNoteFailureCode =
  | "invalid_tenant"
  | "invalid_input"
  | "model_not_allowlisted"
  | "secret_shaped_content"
  | "target_not_found"
  | "target_not_owned_by_customer"
  | "note_not_permitted"
  | "operation_conflict"
  | "operation_in_flight"
  | "odoo_unavailable"
  | "readback_failed"

export interface BusinessNoteInput {
  tenantId: string
  targetModel: string
  targetId: number
  /** The partner this conversation resolved. The target must belong to them. */
  expectedPartnerId: number
  /** What the customer asked for, in their terms. */
  customerRequest: string
  /** What the AI actually did - not what it intends to do. */
  actionTaken: string
  /** What came of it. */
  result: string
  /** What happens next, or plainly that nothing does. */
  nextStep: string
  chatwootConversationId: string
  clawithSessionId: string
  correlationId: string
  operationIdHint: string
}

export interface BusinessNotePolicy {
  allowBusinessNotes: boolean
}

export const DEFAULT_BUSINESS_NOTE_POLICY: BusinessNotePolicy = {
  allowBusinessNotes: true,
}

export interface BusinessNoteRecord {
  messageId: number
  resModel: string
  resId: number
  /** Proven present in the stored body, not merely sent. */
  correlationId: string
}

export type BusinessNoteResult =
  | { ok: true; tool: typeof BUSINESS_NOTE_TOOL; operationId: string; created: boolean; note: BusinessNoteRecord }
  | {
      ok: false
      tool: typeof BUSINESS_NOTE_TOOL
      operationId: string | null
      code: BusinessNoteFailureCode
      detail: string
      messageId?: number
    }

export interface BusinessNoteDeps {
  resolveConfig: (tenantId: string) => Promise<OdooConfig>
  /** Reads the target and returns the partner it belongs to, or null. */
  readTargetPartnerId: (config: OdooConfig, model: BusinessNoteTargetModel, id: number) => Promise<number | null>
  /** Posts the note. Returns the mail.message id Odoo reports, or null. */
  postNote: (
    config: OdooConfig,
    model: BusinessNoteTargetModel,
    id: number,
    body: string,
  ) => Promise<number | null>
  /** The target record's chatter, read back from the RECORD's side. */
  readRecordMessageIds: (
    config: OdooConfig,
    model: BusinessNoteTargetModel,
    id: number,
  ) => Promise<number[] | null>
  /** The stored message itself, so the body can be proven. */
  readMessage: (config: OdooConfig, messageId: number) => Promise<Record<string, unknown> | null>
  store: OperationStore
}

// ── Sanitisation ─────────────────────────────────────────────────────────────

/**
 * Shapes that must never be written into a permanent business record.
 *
 * Deliberately shape-based rather than value-based: we cannot enumerate the
 * secrets a stranger might paste, only what they tend to look like. Each entry
 * is named so a refusal says WHICH shape tripped, which is what makes the
 * refusal actionable instead of mysterious.
 */
export const SECRET_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "private_key_block", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/i },
  { name: "bearer_token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/ },
  { name: "openai_style_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  {
    name: "labelled_credential",
    pattern:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd)\b\s*(?:[:=]|is)\s*\S{8,}/i,
  },
  // A long unbroken hex or base64 run is not prose. 40 hex chars is a SHA-1 or
  // a hex-encoded key; 60 base64 chars is a token. Neither belongs in a note
  // written on a customer's behalf.
  { name: "long_hex_blob", pattern: /\b[0-9a-f]{40,}\b/i },
  { name: "long_base64_blob", pattern: /[A-Za-z0-9+/]{60,}={0,2}/ },
]

/**
 * Tag-shaped runs DELETED rather than replaced with a space.
 *
 * Used only for secret detection, never for the stored body. `sanitiseNoteSection`
 * deliberately leaves a space where a tag was, so that `one<br/>two` reads as
 * `one two` rather than `onetwo` - but that same space defeats a contiguous
 * match on `AKIA<b></b>IOSFODNN7EXAMPLE`, and the token would still be written
 * to the CRM almost intact. This projection is what the evasion is trying to
 * reassemble, so it is what the detector has to see.
 */
export function stripTagsTight(raw: string): string {
  return String(raw ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*(?:>|$)/g, "")
}

/**
 * The first shape matched in ANY projection of the text, or null.
 *
 * Three projections, because markup can hide a token from a contiguous match in
 * either direction: as written, with tags deleted (a token split by them is
 * rejoined), and as it would actually be stored. Patterns are the outer loop so
 * the reported name follows the declared priority order rather than depending on
 * which projection happened to match first.
 */
export function detectSecretShape(text: string): string | null {
  const raw = String(text ?? "")
  const projections = [raw, stripTagsTight(raw), sanitiseNoteSection(raw)]
  for (const { name, pattern } of SECRET_SHAPES) {
    for (const projection of projections) {
      if (pattern.test(projection)) return name
    }
  }
  return null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Strip markup, flatten to one line, bound the length, then escape.
 *
 * The order is the point. Stripping AFTER escaping would be useless - the tags
 * would already be inert text and the strip would find nothing - and escaping
 * without stripping would leave `<script>alert(1)</script>` visible to staff as
 * literal text, which is safe but is noise a human then has to interpret.
 * Stripping first and escaping the remainder means the note reads as the
 * sentence it was meant to be and cannot become markup again.
 */
export function sanitiseNoteSection(raw: string): string {
  const withoutMarkup = String(raw ?? "")
    // Comments first: `<!-- <b> -->` must not leave a live tag behind.
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Any tag-shaped run, closed or not. An unclosed `<script` at the end of
    // the string is removed too, which is why the alternation ends at `$`.
    .replace(/<[^>]*(?:>|$)/g, " ")
  return withoutMarkup
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_NOTE_SECTION_CHARS)
}

export interface BusinessNoteSections {
  customerRequest: string
  actionTaken: string
  result: string
  nextStep: string
}

/**
 * Assemble the chatter body.
 *
 * Every interpolated value is already sanitised and is escaped again here, so
 * this function is safe even if a future caller hands it raw text. Defence in
 * depth is cheap; a stored-XSS regression discovered by staff is not.
 */
export function renderBusinessNoteBody(
  sections: BusinessNoteSections,
  provenance: { conversationId: string; sessionId: string; correlationId: string },
): string {
  const row = (label: string, value: string): string =>
    `<br/><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`
  const body =
    `<p><b>Logged by WhatsApp / Isola AI</b>` +
    row("Customer request", sections.customerRequest) +
    row("Action taken", sections.actionTaken) +
    row("Result", sections.result) +
    row("Next step", sections.nextStep) +
    `<br/><i>Chatwoot conversation: ${escapeHtml(provenance.conversationId)} · ` +
    `Agent session: ${escapeHtml(provenance.sessionId)} · ` +
    `Isola correlation: ${escapeHtml(provenance.correlationId)}</i></p>`
  return body.slice(0, MAX_NOTE_BODY_CHARS)
}

// ── Odoo defaults ────────────────────────────────────────────────────────────

async function defaultReadTargetPartnerId(
  config: OdooConfig,
  model: BusinessNoteTargetModel,
  id: number,
): Promise<number | null> {
  const fields = model === "res.partner" ? ["id"] : ["id", "partner_id"]
  const rows = (await json2Call(
    config,
    model,
    "search_read",
    { domain: [["id", "=", id]], fields, limit: 1 },
    BUSINESS_NOTE_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row) return null
  if (model === "res.partner") return Number(row.id)
  const p = row.partner_id
  if (typeof p === "number") return p
  return Array.isArray(p) && typeof p[0] === "number" ? p[0] : null
}

async function defaultPostNote(
  config: OdooConfig,
  model: BusinessNoteTargetModel,
  id: number,
  body: string,
): Promise<number | null> {
  const res = (await json2Call(
    config,
    model,
    "message_post",
    { ids: [id], body, message_type: "comment" },
    BUSINESS_NOTE_TIMEOUT_MS,
  )) as number[] | number | null
  const messageId = Array.isArray(res) ? res[0] : res
  return typeof messageId === "number" && Number.isInteger(messageId) && messageId > 0 ? messageId : null
}

async function defaultReadRecordMessageIds(
  config: OdooConfig,
  model: BusinessNoteTargetModel,
  id: number,
): Promise<number[] | null> {
  const rows = (await json2Call(
    config,
    model,
    "search_read",
    { domain: [["id", "=", id]], fields: ["id", "message_ids"], limit: 1 },
    BUSINESS_NOTE_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row) return null
  const ids = row.message_ids
  if (!Array.isArray(ids)) return null
  return ids.filter((v): v is number => typeof v === "number")
}

async function defaultReadMessage(
  config: OdooConfig,
  messageId: number,
): Promise<Record<string, unknown> | null> {
  const rows = (await json2Call(
    config,
    "mail.message",
    "search_read",
    { domain: [["id", "=", messageId]], fields: ["id", "model", "res_id", "body", "message_type"], limit: 1 },
    BUSINESS_NOTE_TIMEOUT_MS,
  )) as Record<string, unknown>[]
  return rows && rows.length > 0 ? rows[0] : null
}

export const DEFAULT_BUSINESS_NOTE_DEPS: BusinessNoteDeps = {
  resolveConfig: resolveOdooConfigForTenant,
  readTargetPartnerId: defaultReadTargetPartnerId,
  postNote: defaultPostNote,
  readRecordMessageIds: defaultReadRecordMessageIds,
  readMessage: defaultReadMessage,
  store: prismaOperationStore,
}

function fail(
  operationId: string | null,
  code: BusinessNoteFailureCode,
  detail: string,
  messageId?: number,
): BusinessNoteResult {
  return {
    ok: false,
    tool: BUSINESS_NOTE_TOOL,
    operationId,
    code,
    detail,
    ...(messageId ? { messageId } : {}),
  }
}

// ── The tool ─────────────────────────────────────────────────────────────────

export async function createGovernedBusinessNote(
  input: BusinessNoteInput,
  policy: BusinessNotePolicy = DEFAULT_BUSINESS_NOTE_POLICY,
  deps: BusinessNoteDeps = DEFAULT_BUSINESS_NOTE_DEPS,
): Promise<BusinessNoteResult> {
  if (!(input.tenantId ?? "").trim()) return fail(null, "invalid_tenant", "tenantId is required")
  if (!isBusinessNoteTargetModel(input.targetModel)) {
    return fail(null, "model_not_allowlisted", `${String(input.targetModel)} is not a business-note target model`)
  }
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) {
    return fail(null, "invalid_input", "targetId is required")
  }
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
  if (!SAFE_CORRELATION_ID.test(input.correlationId)) {
    return fail(null, "invalid_input", "correlationId must match [A-Za-z0-9._:-]{1,128}")
  }
  if (!policy.allowBusinessNotes) {
    return fail(null, "note_not_permitted", "tenant policy disables AI business notes")
  }

  const rawSections: BusinessNoteSections = {
    customerRequest: String(input.customerRequest ?? ""),
    actionTaken: String(input.actionTaken ?? ""),
    result: String(input.result ?? ""),
    nextStep: String(input.nextStep ?? ""),
  }

  const sections: BusinessNoteSections = {
    customerRequest: sanitiseNoteSection(rawSections.customerRequest),
    actionTaken: sanitiseNoteSection(rawSections.actionTaken),
    result: sanitiseNoteSection(rawSections.result),
    nextStep: sanitiseNoteSection(rawSections.nextStep),
  }
  // Detection runs against the RAW text; `detectSecretShape` projects it itself,
  // including the markup-stripped forms, so an evasion cannot be dressed up in
  // tags. Checking the sanitised output alone would miss a token that the
  // sanitiser split with a space.
  for (const key of Object.keys(sections) as (keyof BusinessNoteSections)[]) {
    const shape = detectSecretShape(rawSections[key])
    if (shape) {
      // The offending text is NOT echoed in the detail. A refusal that quotes
      // the secret back has copied it into our logs instead of Odoo.
      return fail(null, "secret_shaped_content", `${key} matches ${shape} - refusing the whole note`)
    }
  }

  // Emptiness is checked AFTER sanitisation: a section that was nothing but
  // markup is empty, whatever it looked like on the wire.
  for (const key of ["customerRequest", "actionTaken", "result", "nextStep"] as const) {
    if (!sections[key]) return fail(null, "invalid_input", `${key} is required and must survive sanitisation`)
  }

  const model = input.targetModel as BusinessNoteTargetModel

  // The claim comes FIRST, as in Tool 4 and for the same reason: on a repeat we
  // must answer from the ledger without reading Odoo, because a deleted chatter
  // message would otherwise look like "no note yet" and earn the customer a
  // second one.
  const claim = await claimOperation(
    {
      tenantId: input.tenantId,
      toolName: BUSINESS_NOTE_TOOL,
      conversationId: input.chatwootConversationId,
      correlationId: input.correlationId,
      agentSessionId: input.clawithSessionId,
      hint: input.operationIdHint,
      // The SANITISED sections are what gets authorised and hashed. Hashing the
      // raw text would make two inputs that produce a byte-identical note look
      // like different operations, and a retry would post a duplicate.
      authorisedArguments: {
        targetModel: model,
        targetId: input.targetId,
        partnerId: input.expectedPartnerId,
        sections,
      },
    },
    deps.store,
  )
  if (claim.status === "conflict") return fail(claim.operationId, "operation_conflict", claim.detail)
  if (claim.status === "in_flight") {
    return fail(claim.operationId, "operation_in_flight", "another attempt at this operation is already running")
  }
  if (claim.status === "already_succeeded") {
    const recorded = claim.result as BusinessNoteRecord | null
    if (recorded && typeof recorded === "object") {
      // Odoo is deliberately NOT consulted. The note may since have been
      // deleted, and that must not produce a second one.
      return { ok: true, tool: BUSINESS_NOTE_TOOL, operationId: claim.operationId, created: false, note: recorded }
    }
    return fail(claim.operationId, "readback_failed", "operation recorded as succeeded but carries no readback")
  }

  const recordId = claim.recordId
  const operationId = claim.operationId

  let config: OdooConfig
  try {
    config = await deps.resolveConfig(input.tenantId)
  } catch (err) {
    await failOperation(
      recordId,
      { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null },
      deps.store,
    )
    return fail(operationId, "odoo_unavailable", "tenant Odoo binding could not be resolved")
  }

  try {
    const owner = await deps.readTargetPartnerId(config, model, input.targetId)
    if (owner === null) {
      await failOperation(recordId, { code: "target_not_found", detail: `${model} ${input.targetId}` }, deps.store)
      return fail(operationId, "target_not_found", `${model} ${input.targetId} does not exist on this tenant`)
    }
    if (owner !== input.expectedPartnerId) {
      await failOperation(
        recordId,
        { code: "target_not_owned_by_customer", detail: `${model} ${input.targetId}` },
        deps.store,
      )
      return fail(
        operationId,
        "target_not_owned_by_customer",
        "the target does not belong to the customer this conversation resolved",
      )
    }
  } catch (err) {
    await failOperation(
      recordId,
      { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null },
      deps.store,
    )
    return fail(operationId, "odoo_unavailable", "target ownership could not be verified")
  }

  const body = renderBusinessNoteBody(sections, {
    conversationId: input.chatwootConversationId,
    sessionId: input.clawithSessionId,
    correlationId: input.correlationId,
  })

  let messageId: number | null
  try {
    messageId = await deps.postNote(config, model, input.targetId, body)
  } catch (err) {
    await failOperation(
      recordId,
      { code: "odoo_unavailable", detail: err instanceof Error ? err.message : null },
      deps.store,
    )
    return fail(operationId, "odoo_unavailable", err instanceof Error ? err.message : "message_post failed")
  }
  if (!messageId) {
    await failOperation(recordId, { code: "odoo_unavailable", detail: "message_post returned no id" }, deps.store)
    return fail(operationId, "odoo_unavailable", "message_post returned no usable mail.message id")
  }

  // ── Prove it landed ────────────────────────────────────────────────────────
  // Two independent readbacks, because the id echoed by `message_post` proves
  // only that Odoo accepted a call. The RECORD's `message_ids` proves the note
  // is attached to the record a human will open; the MESSAGE proves the stored
  // body is the one we composed.
  let attached: number[] | null
  let stored: Record<string, unknown> | null
  try {
    attached = await deps.readRecordMessageIds(config, model, input.targetId)
    stored = await deps.readMessage(config, messageId)
  } catch {
    attached = null
    stored = null
  }

  if (attached === null || stored === null) {
    await failOperation(recordId, { code: "readback_failed", detail: `message ${messageId}` }, deps.store)
    return fail(operationId, "readback_failed", "the note was posted but could not be read back", messageId)
  }

  const checks = {
    attached_to_the_record: attached.includes(messageId),
    stored_on_the_right_model: String(stored.model ?? "") === model,
    stored_on_the_right_record: Number(stored.res_id) === input.targetId,
    body_carries_the_correlation_id:
      typeof stored.body === "string" && stored.body.includes(input.correlationId),
  }
  const bad = Object.entries(checks)
    .filter(([, v]) => v !== true)
    .map(([k]) => k)
  if (bad.length) {
    await failOperation(recordId, { code: "readback_failed", detail: bad.join(", ") }, deps.store)
    return fail(operationId, "readback_failed", `note readback did not match: ${bad.join(", ")}`, messageId)
  }

  const note: BusinessNoteRecord = {
    messageId,
    resModel: model,
    resId: input.targetId,
    correlationId: input.correlationId,
  }
  await completeOperation(recordId, { resultModel: "mail.message", resultId: messageId, result: note }, deps.store)
  return { ok: true, tool: BUSINESS_NOTE_TOOL, operationId, created: true, note }
}
