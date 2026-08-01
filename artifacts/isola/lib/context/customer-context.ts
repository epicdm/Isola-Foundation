/**
 * customer-context@1 — the whole Customer 360 answer, assembled once.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * `buildContextBundle` only produces sections it was given adapters for. A UI
 * that iterates `Object.entries(sections)` therefore cannot tell three very
 * different situations apart:
 *
 *   the section was asked for and there is nothing      → empty
 *   the section was asked for and the source failed     → unavailable
 *   the section was never asked for at all              → absent
 *
 * The third one renders as silence, which reads as the first one. So this module
 * takes the bundle and produces a response in which EVERY expected section is
 * present, in a fixed order, carrying its own state — including the five that
 * have no authoritative source, which say so.
 *
 * `loading` is deliberately impossible here. The route has awaited everything
 * before this function is called, so a `loading` section in a finished response
 * would be a fourth way of saying "nothing", and one the reader cannot act on.
 */

import {
  viewSection,
  type SectionState,
  type SectionView,
} from '@/lib/customer-workspace/contract'
import {
  GOVERNED_ACTION_CATALOGUE,
  availableActionsFor,
  type ActionField,
} from '@/lib/governed/executors/catalogue'

import type { ContextBundle, SectionResult } from './context-bundle'
import { odooDeepLink } from './customer-sources'

export const CUSTOMER_CONTEXT_VERSION = 'customer-context@1' as const

/**
 * The sections the workspace promises, in render order. This is the contract
 * the UI iterates; a key missing from a response is a bug, not an empty section.
 */
export const CONTEXT_SECTION_NAMES = [
  'customer',
  'contacts',
  'opportunities',
  'issues',
  'tasks',
  'recentActions',
  'activity',
  'services',
  'devices',
  'pbx',
  'invoices',
  'notes',
] as const
export type ContextSectionName = (typeof CONTEXT_SECTION_NAMES)[number]

/**
 * The Odoo model behind each section that has one, used ONLY to build a deep
 * link. A section absent from this map gets no link — never a guessed one.
 */
export const SECTION_ODOO_MODEL: Readonly<Partial<Record<ContextSectionName, string>>> = {
  customer: 'res.partner',
  contacts: 'res.partner',
  opportunities: 'crm.lead',
  issues: 'helpdesk.ticket',
  tasks: 'project.task',
}

/**
 * Sections whose state means the reader is being told something about the DATA.
 * Records are only ever attached for these. `forbidden` and `unavailable` carry
 * an empty list, and `forbidden` carries nothing else at all.
 */
const CONTENT_STATES: readonly SectionState[] = [
  'available',
  'empty',
  'partial',
  'stale',
  'retrying',
]

export interface ContextSectionEnvelope {
  name: ContextSectionName
  state: SectionState
  count: number
  /** Safe for a screen. Null for `forbidden`, where a reason is itself a disclosure. */
  reason: string | null
  provenance: { source: string; fetchedAt: string; stale: boolean } | null
  missing: readonly string[]
  records: readonly unknown[]
}

export interface AvailableAction {
  actionType: string
  label: string
  writes: string
  riskLevel: string
  requiresApproval: boolean
  expectedResult: string
  fields: readonly ActionField[]
}

export interface CustomerContextResponse {
  version: typeof CUSTOMER_CONTEXT_VERSION
  correlationId: string
  customerId: string
  role: string
  sections: Record<ContextSectionName, ContextSectionEnvelope>
  availableActions: readonly AvailableAction[]
  provenance: {
    generatedAt: string
    /** Sections that could not be answered. Named, so the UI can say so once. */
    degraded: readonly ContextSectionName[]
    /** Sections this reader may not see. Counts only — no names of records. */
    forbiddenCount: number
    sectionCount: number
  }
}

/** The wording an unidentified section uses. No speculation about why. */
export function notConnectedReason(section: ContextSectionName): string {
  return `${section} is not connected: no authoritative source is configured`
}

/**
 * Attach a deep link to a record, and only when all three conditions hold:
 * the record reference exists, the instance URL is configured, and the reader
 * is permitted (which is already true if we reached a content state).
 *
 * `odooDeepLink` returns null for a missing base or an unusable id, so a
 * fabricated URL cannot be produced here even by mistake.
 */
function withLink(record: unknown, model: string | undefined, baseUrl: string | null): unknown {
  if (!model || !record || typeof record !== 'object' || Array.isArray(record)) return record
  const id = (record as { id?: unknown }).id
  const link = odooDeepLink(baseUrl, model, typeof id === 'number' ? id : null)
  return link ? { ...(record as Record<string, unknown>), link } : record
}

function envelopeFrom(
  name: ContextSectionName,
  view: SectionView,
  data: readonly unknown[],
  baseUrl: string | null,
): ContextSectionEnvelope {
  if (view.state === 'forbidden') {
    // No count, no reason, no provenance, no records. Each of those would
    // confirm to a reader who may not know it that the section has content.
    return { name, state: 'forbidden', count: 0, reason: null, provenance: null, missing: [], records: [] }
  }

  const carries = CONTENT_STATES.includes(view.state)
  const model = SECTION_ODOO_MODEL[name]

  return {
    name,
    state: view.state,
    count: view.count,
    reason: view.reason,
    provenance: view.provenance,
    missing: view.missing,
    records: carries ? data.map((r) => withLink(r, model, baseUrl)) : [],
  }
}

/**
 * A section the bundle never produced. This is where the "absent looks empty"
 * failure is actually closed: there is no path from here to `empty`, and none
 * to `loading` either.
 */
function unavailableEnvelope(name: ContextSectionName): ContextSectionEnvelope {
  return {
    name,
    state: 'unavailable',
    count: 0,
    reason: notConnectedReason(name),
    provenance: null,
    missing: [],
    records: [],
  }
}

export interface AssembleInput {
  correlationId: string
  customerId: string
  role: string
  bundle: ContextBundle
  /**
   * The customer-filtered activity feed, already run through the EXISTING
   * activity handler. It is not a bundle section because it is not produced by
   * a BundleAdapter — the activity contract owns its own permission filtering,
   * cursor and per-source reporting, and wrapping it in an adapter would be a
   * second feed wearing the first one's clothes.
   */
  activity: SectionResult<readonly unknown[]> | undefined
  odooBaseUrl: string | null
  permittedActions: readonly string[]
  now: Date
}

export function assembleCustomerContext(input: AssembleInput): CustomerContextResponse {
  const sections = {} as Record<ContextSectionName, ContextSectionEnvelope>
  const degraded: ContextSectionName[] = []
  let forbiddenCount = 0

  for (const name of CONTEXT_SECTION_NAMES) {
    const result =
      name === 'activity'
        ? input.activity
        : (input.bundle.sections[name as keyof typeof input.bundle.sections] as
            | SectionResult<readonly unknown[]>
            | undefined)

    if (result === undefined) {
      sections[name] = unavailableEnvelope(name)
      degraded.push(name)
      continue
    }

    const view = viewSection(result)
    const data = result.status === 'ok' && Array.isArray(result.data) ? result.data : []
    const envelope = envelopeFrom(name, view, data, input.odooBaseUrl)
    sections[name] = envelope

    if (envelope.state === 'forbidden') forbiddenCount += 1
    if (envelope.state === 'unavailable' || envelope.state === 'error') degraded.push(name)
  }

  return {
    version: CUSTOMER_CONTEXT_VERSION,
    correlationId: input.correlationId,
    customerId: input.customerId,
    role: input.role,
    sections,
    availableActions: availableActionsFor(input.role, input.permittedActions).map((a) => ({
      actionType: a.actionType,
      label: a.label,
      writes: a.writes,
      riskLevel: a.riskLevel,
      requiresApproval: a.requiresApproval,
      expectedResult: a.expectedResult,
      fields: a.fields,
    })),
    provenance: {
      generatedAt: input.now.toISOString(),
      degraded,
      forbiddenCount,
      sectionCount: CONTEXT_SECTION_NAMES.length,
    },
  }
}

/** True when the workspace is showing an incomplete picture and must say so. */
export function contextIsIncomplete(response: CustomerContextResponse): boolean {
  return response.provenance.degraded.length > 0
}

/** The six governed actions, whatever this reader may do with them. */
export const ALL_GOVERNED_ACTION_TYPES: readonly string[] = GOVERNED_ACTION_CATALOGUE.map(
  (a) => a.actionType,
)
