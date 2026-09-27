import { describe, expect, it } from 'vitest'

import { ACTIONS_BY_ROLE, ACTIONS_REQUIRING_APPROVAL } from '@/lib/context/resolve-context'

import { buildConversationExecutors, type ConversationSystem } from './conversation'
import { buildExecutors, type RecordSystem } from './index'
import {
  GOVERNED_ACTION_CATALOGUE,
  GOVERNED_ACTION_TYPES,
  availableActionsFor,
  findGovernedAction,
  requiredFieldExample,
  type GovernedActionMeta,
} from './catalogue'

/**
 * Every method throws. `validate()` is pure and never reaches the record system,
 * so any call landing here is itself the bug — a validator that writes.
 */
const NEVER: RecordSystem = new Proxy({} as RecordSystem, {
  get: (_t, prop) => () => {
    throw new Error(`validate() must not reach the record system (called ${String(prop)})`)
  },
})

const NEVER_CONVERSATION: ConversationSystem = new Proxy({} as ConversationSystem, {
  get: (_t, prop) => () => {
    throw new Error(`validate() must not reach the conversation system (called ${String(prop)})`)
  },
})

/**
 * BOTH executor lanes. The sending lane lives in its own module so that
 * `./index.ts` can keep asserting it never sends anything; the catalogue
 * describes every registered action regardless of which lane implements it, so
 * the drift check has to assemble both or it would report a phantom mismatch.
 */
const executors = [...buildExecutors(NEVER), ...buildConversationExecutors(NEVER_CONVERSATION)]
const executorFor = (actionType: string) => executors.find((e) => e.actionType === actionType)

/** A payload built from the catalogue's own description of the action. */
function payloadFrom(meta: GovernedActionMeta, omit?: string): Record<string, unknown> {
  const required = meta.fields.filter((f) => f.required)
  // lead.update requires no single field but does require at least one of them.
  const use = required.length > 0 ? required : meta.fields.slice(0, 1)
  const out: Record<string, unknown> = {}
  for (const f of use) {
    if (f.name === omit) continue
    out[f.name] = requiredFieldExample(f)
  }
  return out
}

/* ── the drift check ───────────────────────────────────────────────────────*/

describe('the catalogue describes the executors that actually exist', () => {
  it('describes exactly the registered action types, no more and no fewer', () => {
    expect([...GOVERNED_ACTION_TYPES].sort()).toEqual(executors.map((e) => e.actionType).sort())
    expect(GOVERNED_ACTION_CATALOGUE).toHaveLength(8)
  })

  it.each(GOVERNED_ACTION_CATALOGUE.map((m) => [m.actionType, m] as const))(
    '%s matches its executor on risk and roles',
    (_name, meta) => {
      const executor = executorFor(meta.actionType)
      expect(executor).toBeDefined()
      expect(meta.riskLevel).toBe(executor!.riskLevel)
      expect([...meta.allowedRoles].sort()).toEqual([...executor!.allowedRoles].sort())
    },
  )

  it.each(GOVERNED_ACTION_CATALOGUE.map((m) => [m.actionType, m] as const))(
    'a payload built from the catalogue PASSES %s validate()',
    (_name, meta) => {
      const verdict = executorFor(meta.actionType)!.validate(payloadFrom(meta))
      expect(verdict).toEqual({ ok: true })
    },
  )

  it.each(
    GOVERNED_ACTION_CATALOGUE.flatMap((m) =>
      m.fields.filter((f) => f.required).map((f) => [m.actionType, f.name, m] as const),
    ),
  )('%s FAILS validate() when the catalogue-required field %s is missing', (_a, field, meta) => {
    const verdict = executorFor(meta.actionType)!.validate(payloadFrom(meta, field))
    expect(verdict.ok).toBe(false)
  })

  it('declares approval exactly where the ratified list requires it', () => {
    for (const meta of GOVERNED_ACTION_CATALOGUE) {
      expect(meta.requiresApproval).toBe(ACTIONS_REQUIRING_APPROVAL.includes(meta.actionType))
    }
    // Not a vacuous assertion: at least one action really does need a human.
    expect(GOVERNED_ACTION_CATALOGUE.some((m) => m.requiresApproval)).toBe(true)
  })
})

/* ── the name decision ─────────────────────────────────────────────────────*/

describe('note.create is the canonical name', () => {
  it('is registered, and note.add is not', () => {
    expect(GOVERNED_ACTION_TYPES).toContain('note.create')
    expect(GOVERNED_ACTION_TYPES).not.toContain('note.add')
    expect(findGovernedAction('note.add')).toBeNull()
    expect(findGovernedAction('note.create')).not.toBeNull()
  })

  it('appears nowhere in the role catalogue either', () => {
    for (const actions of Object.values(ACTIONS_BY_ROLE)) {
      expect(actions).not.toContain('note.add')
    }
  })
})

/* ── the two lists have to agree ───────────────────────────────────────────*/

describe('an offered action is one BOTH gates permit', () => {
  it('offers a manager all eight', () => {
    const offered = availableActionsFor('manager', ACTIONS_BY_ROLE.manager).map((a) => a.actionType)
    expect(offered.sort()).toEqual(
      [
        'activity.schedule',
        'document.send',
        'followup.schedule',
        'followup.scheduleAssigned',
        'lead.create',
        'lead.update',
        'note.create',
        'task.create',
      ].sort(),
    )
  })

  it('does not offer a service account the one action that reaches a customer', () => {
    // service_account inherits STAFF_ACTIONS, which lists document.send. The
    // executor's allowedRoles is the gate that actually stops it, and this
    // asserts the two lists disagree in the SAFE direction rather than by luck.
    expect(ACTIONS_BY_ROLE.service_account).toContain('document.send')
    const offered = availableActionsFor(
      'service_account',
      ACTIONS_BY_ROLE.service_account,
    ).map((a) => a.actionType)
    expect(offered).not.toContain('document.send')
  })

  it('does not offer staff the manager-only lead update', () => {
    const offered = availableActionsFor('staff', ACTIONS_BY_ROLE.staff).map((a) => a.actionType)
    expect(offered).not.toContain('lead.update')
  })

  it('offers nothing an executor would refuse on role grounds', () => {
    for (const role of ['staff', 'manager', 'owner', 'service_account'] as const) {
      for (const meta of availableActionsFor(role, ACTIONS_BY_ROLE[role])) {
        expect(executorFor(meta.actionType)!.allowedRoles).toContain(role)
      }
    }
  })

  it('offers nothing the context resolver has not permitted', () => {
    // An empty permitted set offers nothing, whatever the executor allows.
    expect(availableActionsFor('owner', [])).toEqual([])
  })
})

/* ── what the workbench promises before it sends ───────────────────────────*/

describe('every action can describe itself before it runs', () => {
  it.each(GOVERNED_ACTION_CATALOGUE.map((m) => [m.actionType, m] as const))(
    '%s says what it writes and what proof it expects',
    (_name, meta) => {
      expect(meta.writes.length).toBeGreaterThan(10)
      expect(meta.expectedResult.length).toBeGreaterThan(10)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.fields.length).toBeGreaterThan(0)
    },
  )

  it('does not promise that scheduling a follow-up contacts anyone', () => {
    const followup = findGovernedAction('followup.schedule')!
    expect(followup.writes.toLowerCase()).toContain('does not send')
  })
})
