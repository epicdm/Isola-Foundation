/**
 * work-ref.ts — the Wave 1 WorkRef contract. Odoo-only, by ratified decision.
 *
 * AUTHORITY: `dec-wave1-workref-odoo-only-2026-07-28` (Ratified 2026-07-28).
 *
 *   Foundation WorkRef is keyed exclusively to authoritative Odoo records:
 *       { odooModel, odooId, correlationId }
 *   where odooModel ∈ { project.task, mail.activity, helpdesk.ticket }.
 *
 * WHAT THIS DELIBERATELY DOES NOT CONTAIN — and why the omission is the point
 *   There is NO EpicWorkItem id, no `OPS-` reference, no compatibility field,
 *   no read-through, no mirror and no BFF database dependency anywhere in this
 *   module or anything that consumes it. That is not an oversight to be
 *   "improved" later: read-only substrate evidence on 2026-07-28 established
 *   that 50 of 51 `epic_work_items` rows carry no Odoo model/id at all, and the
 *   single row that does (OPS-000052 → project.task 2570) points at a task that
 *   does not exist. `EpicWorkItem` is therefore not a projection of a system of
 *   record — it IS a competing authority. Giving Foundation any handle on it
 *   would import the exact second task authority this programme exists to
 *   remove, and would have to be un-built before BFF could be retired.
 *
 *   If you are reading this because you want to correlate a Foundation action
 *   back to an OPS- row: don't. Correlate on `correlationId`, which is minted
 *   here and is Foundation's own, or on the Odoo record itself.
 *
 * WHAT `correlationId` IS FOR
 *   One staff work episode — dispatch, delivery callback, inbound reply,
 *   manager verification — spans several subsystems that each have their own
 *   ids (Meta wamid, NotificationOutbox row id, Odoo message id). correlationId
 *   is the one value that appears on all of them so a human or a query can
 *   reassemble the episode. It carries no authority: losing it loses a trail,
 *   not a fact.
 */

/** The only Odoo models Foundation will accept as authoritative work. */
export const WORK_REF_MODELS = ['project.task', 'mail.activity', 'helpdesk.ticket'] as const

export type WorkRefModel = (typeof WORK_REF_MODELS)[number]

export interface WorkRef {
  odooModel: WorkRefModel
  odooId: number
  correlationId: string
}

export type WorkRefParseResult =
  | { ok: true; workRef: WorkRef }
  | { ok: false; reason: WorkRefParseFailure }

export type WorkRefParseFailure =
  | 'unknown_model'
  | 'invalid_id'
  | 'missing_correlation_id'
  | 'malformed'

/** True iff `value` is one of the three authoritative Odoo models. */
export function isWorkRefModel(value: unknown): value is WorkRefModel {
  return typeof value === 'string' && (WORK_REF_MODELS as readonly string[]).includes(value)
}

/**
 * Canonical string form: `project.task#2292@<correlationId>`.
 *
 * Used as a stable key in logs, audit meta and idempotency keys. Chosen over
 * JSON so it survives being pasted into a log line, a WhatsApp message or a
 * grep without quoting games.
 */
export function formatWorkRef(ref: WorkRef): string {
  return `${ref.odooModel}#${ref.odooId}@${ref.correlationId}`
}

/**
 * Parse the canonical string form. Fails CLOSED on anything it does not
 * recognise — an unparseable ref must never degrade into "probably that task".
 */
export function parseWorkRef(raw: string): WorkRefParseResult {
  const m = /^([a-z_.]+)#(\d+)@([A-Za-z0-9_:-]+)$/.exec((raw ?? '').trim())
  if (!m) return { ok: false, reason: 'malformed' }

  const [, model, idRaw, correlationId] = m
  if (!isWorkRefModel(model)) return { ok: false, reason: 'unknown_model' }

  const odooId = Number(idRaw)
  if (!Number.isInteger(odooId) || odooId <= 0) return { ok: false, reason: 'invalid_id' }
  if (!correlationId) return { ok: false, reason: 'missing_correlation_id' }

  return { ok: true, workRef: { odooModel: model, odooId, correlationId } }
}

/**
 * Build a WorkRef from raw parts, validating the model and id. `correlationId`
 * is supplied by the caller rather than minted here so that a single episode
 * can carry one id across several WorkRefs (e.g. a project.task and the
 * mail.activity that verifies it).
 */
export function makeWorkRef(
  odooModel: string,
  odooId: number,
  correlationId: string,
): WorkRefParseResult {
  if (!isWorkRefModel(odooModel)) return { ok: false, reason: 'unknown_model' }
  if (!Number.isInteger(odooId) || odooId <= 0) return { ok: false, reason: 'invalid_id' }
  if (!correlationId?.trim()) return { ok: false, reason: 'missing_correlation_id' }
  return { ok: true, workRef: { odooModel, odooId, correlationId: correlationId.trim() } }
}

/**
 * Mint a correlation id for a new staff work episode.
 *
 * Shape: `sw-<tenantShort>-<odooModelShort>-<odooId>-<nonce>`. Deterministic
 * prefix so an operator can eyeball which tenant and record an episode belongs
 * to; random suffix so two dispatches of the same task are distinguishable.
 *
 * `nonce` is injectable purely so tests are deterministic — production callers
 * omit it.
 */
export function mintCorrelationId(
  tenantId: string,
  odooModel: WorkRefModel,
  odooId: number,
  nonce?: string,
): string {
  const tenantShort = tenantId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'unknown'
  const modelShort = odooModel.split('.').pop() ?? odooModel
  const suffix = nonce ?? Math.random().toString(36).slice(2, 10)
  return `sw-${tenantShort}-${modelShort}-${odooId}-${suffix}`
}
