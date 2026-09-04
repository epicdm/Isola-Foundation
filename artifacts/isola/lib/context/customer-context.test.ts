import { describe, expect, it } from 'vitest'

import { ACTIONS_BY_ROLE } from './resolve-context'
import { buildContextBundle, type BundleAdapter, type ContextBundle } from './context-bundle'
import {
  CONTEXT_SECTION_NAMES,
  assembleCustomerContext,
  contextIsIncomplete,
  type ContextSectionName,
} from './customer-context'
import { buildCustomerAdapters, TASKS_NOT_PROVEN_REASON, type OdooCaller } from './customer-sources'
import { recentActionsAdapter, type RecentActionsStore } from './recent-actions'

const NOW = new Date('2026-08-01T12:00:00Z')
const ODOO = 'https://tenant.odoo.com'

/**
 * `undefined` means "the test did not care"; `null` means "there is no instance
 * URL". Collapsing them with `??` is what let the no-link test pass while
 * running with a URL configured.
 */
const baseUrlOf = (opts: { baseUrl?: string | null }): string | null =>
  opts.baseUrl === undefined ? ODOO : opts.baseUrl

const PARTNER = { id: 42, name: 'Marigot Hardware', email: null, phone: null, city: null, street: null, is_company: true, parent_id: false, active: true }
const CONTACT = { id: 77, name: 'A Contact', email: null, phone: null, function: 'Owner' }
const LEAD = { id: 5, name: 'Second line', type: 'opportunity', stage_id: [1, 'New'], user_id: false, expected_revenue: 0, date_deadline: false, write_date: '2026-07-01 10:00:00' }
const TICKET = { id: 9, name: 'Line dropping', stage_id: [2, 'In progress'], priority: '1', user_id: false, create_date: '2026-07-02 09:00:00', write_date: '2026-07-03 09:00:00' }

/** A fake Odoo. Each model can be made to answer, to answer nothing, or to fail. */
function caller(over: Partial<Record<string, unknown[] | 'fail'>> = {}): OdooCaller {
  const answers: Record<string, unknown[] | 'fail'> = {
    'res.partner': [PARTNER],
    'crm.lead': [LEAD],
    'helpdesk.ticket': [TICKET],
    ...over,
  }
  return async (model, _method, params) => {
    const answer = answers[model]
    if (answer === 'fail') throw new Error('connect ECONNREFUSED 10.1.2.3:443')
    // res.partner serves both the customer and its contacts; the domain says which.
    if (model === 'res.partner') {
      const domain = JSON.stringify((params as { domain?: unknown }).domain ?? [])
      if (domain.includes('parent_id')) return (over['res.partner:contacts'] as unknown[]) ?? [CONTACT]
      return answer ?? []
    }
    return answer ?? []
  }
}

const emptyStore: RecentActionsStore = { list: async () => [] }

interface Opts {
  role?: string
  store?: RecentActionsStore
  baseUrl?: string | null
  activity?: Parameters<typeof assembleCustomerContext>[0]['activity']
  activityMissing?: readonly string[]
}

async function bundleWith(call: OdooCaller, opts: Opts = {}): Promise<ContextBundle> {
  const adapters: BundleAdapter[] = [
    ...buildCustomerAdapters({ call, odooBaseUrl: baseUrlOf(opts), now: () => NOW }),
    recentActionsAdapter({ store: opts.store ?? emptyStore, tenantId: 'tenant-1', now: () => NOW }),
  ]
  return buildContextBundle(
    {
      correlationId: 'corr-1',
      companyId: 'tenant-1',
      role: opts.role ?? 'manager',
      objectType: 'customer',
      objectId: '42',
      limit: 25,
    },
    { adapters, workspaceUrlFor: () => '', now: () => NOW },
  )
}

async function assemble(call: OdooCaller, opts: Opts = {}) {
  const role = opts.role ?? 'manager'
  return assembleCustomerContext({
    correlationId: 'corr-1',
    customerId: '42',
    role,
    bundle: await bundleWith(call, opts),
    activity:
      opts.activity ?? {
        status: 'ok',
        data: [],
        provenance: { source: 'activity@1', fetchedAt: NOW, stale: false },
      },
    activityMissing: opts.activityMissing,
    odooBaseUrl: baseUrlOf(opts),
    permittedActions: ACTIONS_BY_ROLE[role as 'manager'] ?? [],
    now: NOW,
  })
}

/* ── the shape promise ─────────────────────────────────────────────────────*/

describe('every expected section is present in every response', () => {
  it('returns all twelve, whatever happened', async () => {
    const good = await assemble(caller())
    const bad = await assemble(caller({ 'res.partner': 'fail', 'crm.lead': 'fail', 'helpdesk.ticket': 'fail' }))

    for (const response of [good, bad]) {
      expect(Object.keys(response.sections).sort()).toEqual([...CONTEXT_SECTION_NAMES].sort())
      // 15, not the historical 12 — orders/calls/files joined the promised
      // section set in dec-c360-design-defines-the-target-find-the-data-2026-09-04.
      expect(response.provenance.sectionCount).toBe(15)
    }
  })

  it('never reports a finished response as still loading', async () => {
    const response = await assemble(caller({ 'res.partner': 'fail' }))
    for (const section of Object.values(response.sections)) {
      expect(section.state).not.toBe('loading')
    }
  })

  it('names every section that could not be answered', async () => {
    const response = await assemble(caller())
    // The four unidentified sections, plus tasks (refused for its own
    // reason) and calls/files (real, named gaps added the same pass
    // invoices got a real adapter — invoices is NOT in this list any more).
    expect(response.provenance.degraded).toEqual(
      expect.arrayContaining(['services', 'devices', 'pbx', 'notes', 'tasks', 'calls', 'files']),
    )
    expect(contextIsIncomplete(response)).toBe(true)
  })
})

/* ── unidentified is not empty ─────────────────────────────────────────────*/

describe('a section with no source says so', () => {
  it.each(['services', 'devices', 'pbx', 'notes', 'calls', 'files'] as ContextSectionName[])(
    '%s is unavailable, not empty, and carries no records',
    async (name) => {
      const response = await assemble(caller())
      const section = response.sections[name]

      expect(section.state).toBe('unavailable')
      expect(section.state).not.toBe('empty')
      expect(section.records).toEqual([])
      expect(section.reason).toContain('not connected')
    },
  )

  it('explains only that the source is not connected, with no speculation', async () => {
    const response = await assemble(caller())
    const reason = response.sections.invoices.reason ?? ''

    expect(reason).not.toMatch(/error|stack|exception|undefined|null/i)
    expect(reason).not.toContain('account.move')
  })

  it('reports tasks as unavailable with its own reason, having proven nothing about the domain', async () => {
    const response = await assemble(caller())

    expect(response.sections.tasks.state).toBe('unavailable')
    expect(response.sections.tasks.reason).toBe(TASKS_NOT_PROVEN_REASON)
    expect(response.sections.tasks.records).toEqual([])
  })
})

/* ── a dead source is not an empty one ─────────────────────────────────────*/

describe('a source that failed and a source that is empty look different', () => {
  it('reports a failed read as unavailable', async () => {
    const response = await assemble(caller({ 'crm.lead': 'fail' }))

    expect(response.sections.opportunities.state).toBe('unavailable')
    expect(response.sections.opportunities.count).toBe(0)
    expect(response.sections.opportunities.records).toEqual([])
  })

  it('reports a successful read of nothing as empty, WITH provenance', async () => {
    const response = await assemble(caller({ 'crm.lead': [] }))
    const section = response.sections.opportunities

    expect(section.state).toBe('empty')
    expect(section.count).toBe(0)
    expect(section.provenance?.source).toBe('odoo:crm.lead')
    expect(section.reason).toBeNull()
  })

  it('does not put driver text on the screen when a source fails', async () => {
    const response = await assemble(caller({ 'helpdesk.ticket': 'fail' }))
    const reason = response.sections.issues.reason ?? ''

    expect(reason).not.toContain('ECONNREFUSED')
    expect(reason).not.toContain('10.1.2.3')
    expect(reason).toBe('the source could not be reached')
  })

  it('keeps the sections that DID answer when one of them fails', async () => {
    const response = await assemble(caller({ 'crm.lead': 'fail' }))

    expect(response.sections.customer.state).toBe('available')
    expect(response.sections.issues.state).toBe('available')
    expect(response.sections.opportunities.state).toBe('unavailable')
  })
})

/* ── forbidden discloses nothing ───────────────────────────────────────────*/

describe('a forbidden section is silent about what is behind it', () => {
  it('carries no count, no reason, no provenance and no records', async () => {
    // `staff` is not in the adapters' allowedRoles, so every section refuses.
    const response = await assemble(caller(), { role: 'staff' })
    const section = response.sections.customer

    expect(section.state).toBe('forbidden')
    expect(section.count).toBe(0)
    expect(section.reason).toBeNull()
    expect(section.provenance).toBeNull()
    expect(section.records).toEqual([])
  })

  it('is not counted as degraded, because nothing failed', async () => {
    const response = await assemble(caller(), { role: 'staff' })

    expect(response.provenance.degraded).not.toContain('customer')
    expect(response.provenance.forbiddenCount).toBeGreaterThan(0)
  })
})

/* ── links ─────────────────────────────────────────────────────────────────*/

describe('a link is offered only when it can be built honestly', () => {
  it('links a record when the reference and the instance URL both exist', async () => {
    const response = await assemble(caller())
    const [customer] = response.sections.customer.records as { link?: string }[]

    expect(customer.link).toBe(`${ODOO}/odoo/res.partner/42`)
  })

  it('offers NO link when the instance URL is not configured', async () => {
    const response = await assemble(caller(), { baseUrl: null })
    const [customer] = response.sections.customer.records as { link?: string }[]

    expect(customer.link).toBeUndefined()
    // And nothing anywhere in the response invented one.
    expect(JSON.stringify(response)).not.toContain('/odoo/')
  })

  it('uses the right model per section rather than one guessed base', async () => {
    const response = await assemble(caller())
    const [lead] = response.sections.opportunities.records as { link?: string }[]
    const [ticket] = response.sections.issues.records as { link?: string }[]

    expect(lead.link).toContain('/odoo/crm.lead/5')
    expect(ticket.link).toContain('/odoo/helpdesk.ticket/9')
  })

  it('offers no link on a section that has no model behind it', async () => {
    const store: RecentActionsStore = { list: async () => [] }
    const response = await assemble(caller(), { store })

    expect(JSON.stringify(response.sections.recentActions.records)).not.toContain('/odoo/')
  })
})

/* ── the activity slice ────────────────────────────────────────────────────*/

describe('activity is partial when one of its sources did not answer', () => {
  it('keeps the rows and names what is missing', async () => {
    const response = await assemble(caller(), {
      activity: {
        status: 'ok',
        data: [{ activityId: 'audit:1' }],
        provenance: { source: 'activity@1', fetchedAt: NOW, stale: false },
      },
      activityMissing: ['lane2'],
    })
    const section = response.sections.activity

    expect(section.state).toBe('partial')
    expect(section.count).toBe(1)
    expect(section.missing).toEqual(['lane2'])
  })

  it('is available when every source answered', async () => {
    const response = await assemble(caller(), {
      activity: {
        status: 'ok',
        data: [{ activityId: 'audit:1' }],
        provenance: { source: 'activity@1', fetchedAt: NOW, stale: false },
      },
      activityMissing: [],
    })

    expect(response.sections.activity.state).toBe('available')
  })

  it('is unavailable, not empty, when the feed could not be read', async () => {
    const response = await assemble(caller(), {
      activity: { status: 'unavailable', reason: 'the activity feed could not be reached', source: 'activity' },
    })

    expect(response.sections.activity.state).toBe('unavailable')
    expect(response.sections.activity.records).toEqual([])
  })
})

/* ── actions offered ───────────────────────────────────────────────────────*/

describe('the actions offered are the ones both gates permit', () => {
  it('offers a manager the seven governed actions and flags the one needing approval', async () => {
    const response = await assemble(caller())
    const offered = response.availableActions.map((a) => a.actionType).sort()

    expect(offered).toEqual(
      [
        'activity.schedule',
        'document.send',
        'followup.schedule',
        'lead.create',
        'lead.update',
        'note.create',
        'task.create',
      ].sort(),
    )
    expect(response.availableActions.find((a) => a.actionType === 'lead.update')?.requiresApproval).toBe(true)
    expect(response.availableActions.find((a) => a.actionType === 'note.create')?.requiresApproval).toBe(false)
  })

  it('never offers note.add', async () => {
    const response = await assemble(caller())
    expect(response.availableActions.map((a) => a.actionType)).not.toContain('note.add')
  })

  it('says what each action writes before anything is sent', async () => {
    const response = await assemble(caller())
    for (const action of response.availableActions) {
      expect(action.writes.length).toBeGreaterThan(10)
      expect(action.expectedResult.length).toBeGreaterThan(10)
    }
  })
})

/* ── nothing invented ──────────────────────────────────────────────────────*/

describe('no record is fabricated anywhere in the response', () => {
  it('renders no rows at all when every source is dead', async () => {
    const response = await assemble(
      caller({ 'res.partner': 'fail', 'crm.lead': 'fail', 'helpdesk.ticket': 'fail' }),
    )

    for (const section of Object.values(response.sections)) {
      expect(section.records).toEqual([])
    }
  })

  it('carries no placeholder, sample or example text', async () => {
    const serialised = JSON.stringify(await assemble(caller()))

    expect(serialised).not.toMatch(/lorem|placeholder|sample customer|john doe|acme/i)
  })
})
