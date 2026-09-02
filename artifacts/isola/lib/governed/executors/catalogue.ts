/**
 * catalogue@1 — the six governed actions, described without building them.
 *
 * WHY THIS IS NOT JUST `buildExecutors(...)`
 * ------------------------------------------
 * An executor is a thing that WRITES. Constructing one requires a RecordSystem,
 * which requires a resolved Odoo binding. But the workbench has to describe an
 * action before anyone has decided to run it — what it will write, which fields
 * it takes, whether it needs approval — and a page that resolves a tenant's Odoo
 * credentials in order to render a form label has got its dependencies backwards.
 *
 * So this is metadata, and metadata only. Nothing here can perform anything.
 *
 * THE DRIFT PROBLEM, AND HOW IT IS ACTUALLY SOLVED
 * -----------------------------------------------
 * A hand-maintained description of code that lives elsewhere goes stale, and a
 * stale form is worse than no form: it offers a field the executor ignores, or
 * omits one the executor requires, and the reader discovers this by having their
 * work refused.
 *
 * `catalogue.test.ts` therefore does not compare this file to a copy of itself.
 * It builds the REAL executors and asserts, for every entry:
 *   - the action type exists in the registry;
 *   - riskLevel and allowedRoles match the executor exactly;
 *   - a payload assembled from the required fields here PASSES that executor's
 *     own validate();
 *   - a payload missing any one of them FAILS it.
 * Adding a required field to an executor without adding it here fails the suite.
 */

import type { RiskLevel } from '../action'

export const ACTION_CATALOGUE_VERSION = 'governed-catalogue@1' as const

export type FieldKind = 'text' | 'longtext' | 'date' | 'reference' | 'choice' | 'number'

export interface ActionField {
  name: string
  label: string
  kind: FieldKind
  required: boolean
  /** Enforced by the executor. Shown so a reader is not refused for a surprise. */
  maxLength?: number
  choices?: readonly string[]
  /** Plain-language help. Never a schema dump. */
  help?: string
}

export interface GovernedActionMeta {
  actionType: string
  label: string
  /**
   * What this WRITES, in the reader's words. The workbench shows it before
   * execution, so "proposed mutation" is a sentence rather than a JSON blob.
   */
  writes: string
  riskLevel: RiskLevel
  allowedRoles: readonly string[]
  /** True when a human must rule on it before it can run. */
  requiresApproval: boolean
  fields: readonly ActionField[]
  /**
   * What the reader should expect to be able to see afterwards. Used for the
   * workbench's "expected result" line, which is a promise about the readback,
   * not about the HTTP response.
   */
  expectedResult: string
}

/**
 * `note.add` is NOT here and must never be. The executor is registered as
 * `note.create`, that is the name `runGovernedAction` looks up, and a proposal
 * carrying `note.add` has no executor behind it.
 */
export const GOVERNED_ACTION_CATALOGUE: readonly GovernedActionMeta[] = [
  {
    actionType: 'note.create',
    label: 'Add a note',
    writes: 'Records a note against this customer in the system of record.',
    riskLevel: 'low',
    allowedRoles: ['staff', 'manager', 'owner', 'service_account'],
    requiresApproval: false,
    fields: [
      {
        name: 'body',
        label: 'Note',
        kind: 'longtext',
        required: true,
        maxLength: 5000,
        help: 'What happened, in your own words. This is stored, not sent to anyone.',
      },
    ],
    expectedResult: 'The note is read back from the system of record before it is reported as done.',
  },
  {
    actionType: 'task.create',
    label: 'Create a task',
    writes: 'Creates a task in the system of record, linked to this customer.',
    riskLevel: 'medium',
    allowedRoles: ['staff', 'manager', 'owner'],
    requiresApproval: false,
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true, maxLength: 200 },
      { name: 'assigneeRef', label: 'Assign to', kind: 'reference', required: false },
      { name: 'dueDate', label: 'Due', kind: 'date', required: false },
    ],
    expectedResult: 'The task is read back by title before it is reported as done.',
  },
  {
    actionType: 'activity.schedule',
    label: 'Schedule an activity',
    writes: 'Schedules a dated activity against this customer in the system of record.',
    riskLevel: 'medium',
    allowedRoles: ['staff', 'manager', 'owner'],
    requiresApproval: false,
    fields: [
      { name: 'summary', label: 'Summary', kind: 'text', required: true },
      { name: 'dueDate', label: 'Due', kind: 'date', required: true },
      { name: 'assigneeRef', label: 'Assign to', kind: 'reference', required: false },
    ],
    expectedResult: 'The activity is read back by summary before it is reported as done.',
  },
  {
    actionType: 'lead.create',
    label: 'Create a lead',
    writes: 'Creates a new lead in the CRM.',
    riskLevel: 'medium',
    allowedRoles: ['staff', 'manager', 'owner'],
    requiresApproval: false,
    fields: [
      { name: 'name', label: 'Lead name', kind: 'text', required: true, maxLength: 120 },
      { name: 'contactRef', label: 'Contact', kind: 'reference', required: false },
      { name: 'source', label: 'Source', kind: 'text', required: false },
    ],
    expectedResult: 'The lead is read back by name before it is reported as done.',
  },
  {
    actionType: 'lead.update',
    label: 'Update a lead',
    writes: 'Changes fields on an existing lead in the CRM.',
    riskLevel: 'medium',
    allowedRoles: ['manager', 'owner'],
    // Governed by ACTIONS_REQUIRING_APPROVAL in resolve-context. Asserted there.
    requiresApproval: true,
    fields: [
      {
        name: 'stage',
        label: 'Stage',
        kind: 'choice',
        required: false,
        choices: ['new', 'qualified', 'proposition', 'won', 'lost'],
      },
      { name: 'name', label: 'Lead name', kind: 'text', required: false },
      { name: 'ownerRef', label: 'Owner', kind: 'reference', required: false },
      { name: 'expectedRevenue', label: 'Expected revenue', kind: 'number', required: false },
    ],
    expectedResult:
      'Every field you changed is read back changed. A partial write is reported as unconfirmed, not as done.',
  },
  {
    actionType: 'followup.schedule',
    label: 'Schedule a follow-up',
    writes:
      'Records the intention to follow up. It does not send anything to the customer.',
    riskLevel: 'low',
    allowedRoles: ['staff', 'manager', 'owner'],
    requiresApproval: false,
    fields: [
      { name: 'note', label: 'Follow-up note', kind: 'longtext', required: true, maxLength: 2000 },
      { name: 'dueDate', label: 'Due', kind: 'date', required: true },
      { name: 'ownerRef', label: 'Owner', kind: 'reference', required: false },
    ],
    expectedResult: 'The follow-up is read back by its note before it is reported as done.',
  },
] as const

export const GOVERNED_ACTION_TYPES: readonly string[] = GOVERNED_ACTION_CATALOGUE.map(
  (a) => a.actionType,
)

export function findGovernedAction(actionType: string): GovernedActionMeta | null {
  return GOVERNED_ACTION_CATALOGUE.find((a) => a.actionType === actionType) ?? null
}

/**
 * The actions this role may propose.
 *
 * BOTH lists have to agree. `allowedRoles` on the executor is what
 * `runGovernedAction` actually enforces; `permitted` is what the context
 * resolver says this principal may do. Offering an action that passes one and
 * fails the other produces a button whose only outcome is a refusal.
 */
export function availableActionsFor(
  role: string,
  permitted: readonly string[],
): readonly GovernedActionMeta[] {
  return GOVERNED_ACTION_CATALOGUE.filter(
    (a) => a.allowedRoles.includes(role) && permitted.includes(a.actionType),
  )
}

/** A minimal example payload, used by the drift test and by nothing else. */
export function requiredFieldExample(field: ActionField): string {
  if (field.kind === 'date') return '2026-09-01'
  if (field.kind === 'number') return '100'
  if (field.kind === 'choice') return field.choices?.[0] ?? 'new'
  return `example ${field.name}`
}
