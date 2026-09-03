/**
 * The workspace, rendered.
 *
 * Same arrangement as `components/activity/recent-work-view.test.tsx`: this
 * workspace has no jsdom, no @testing-library and no axe, so these are not
 * browser tests. What they prove is the MARKUP the reader is sent — the heading
 * structure, the label-to-control wiring, the live regions, and every honesty
 * rule expressible as "this string is present" or "this string is absent".
 *
 * The view is a pure function of its props precisely so this is possible.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ACTION_LIFECYCLE_STATES,
  LIFECYCLE_PRESENTATION,
  SECTION_STATES,
  type ActionLifecycleState,
  type SectionState,
} from '@/lib/customer-workspace/contract'
import { CONTEXT_SECTION_NAMES, type ContextSectionEnvelope, type ContextSectionName, type CustomerContextResponse } from '@/lib/context/customer-context'
import { GOVERNED_ACTION_CATALOGUE } from '@/lib/governed/executors/catalogue'

import {
  ActionResult,
  CustomerWorkspaceView,
  LifecycleBadge,
  NativeSurface,
  SectionCard,
  type ActionOutcomeView,
  type WorkspaceViewProps,
} from './workspace-view'

const noop = () => {}

function section(
  name: ContextSectionName,
  over: Partial<ContextSectionEnvelope> = {},
): ContextSectionEnvelope {
  return {
    name,
    state: 'available',
    count: 1,
    reason: null,
    provenance: { source: 'odoo:res.partner', fetchedAt: '2026-08-01T12:00:00.000Z', stale: false },
    missing: [],
    records: [{ id: 42, name: 'Marigot Hardware' }],
    ...over,
  }
}

function response(over: Partial<CustomerContextResponse> = {}): CustomerContextResponse {
  const sections = {} as Record<ContextSectionName, ContextSectionEnvelope>
  for (const name of CONTEXT_SECTION_NAMES) sections[name] = section(name)
  return {
    version: 'customer-context@1',
    correlationId: 'corr-1',
    customerId: '42',
    role: 'manager',
    sections,
    availableActions: GOVERNED_ACTION_CATALOGUE.map((a) => ({
      actionType: a.actionType,
      label: a.label,
      writes: a.writes,
      riskLevel: a.riskLevel,
      requiresApproval: a.requiresApproval,
      expectedResult: a.expectedResult,
      fields: a.fields,
    })),
    provenance: {
      generatedAt: '2026-08-01T12:00:00.000Z',
      degraded: [],
      forbiddenCount: 0,
      sectionCount: 12,
    },
    ...over,
  }
}

function props(over: Partial<WorkspaceViewProps> = {}): WorkspaceViewProps {
  return {
    customerId: '42',
    status: 'ready',
    context: response(),
    errorDetail: null,
    selectedTab: 'sales',
    selectedAction: null,
    actionValues: {},
    actionOutcome: null,
    actionPending: false,
    onSelectTab: noop,
    onSelectAction: noop,
    onChangeField: noop,
    onRun: noop,
    onRetryContext: noop,
    ...over,
  }
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node)

/** Text content only, so a class name containing a word cannot satisfy a test. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

/* ── no blank cards ────────────────────────────────────────────────────────*/

describe('every section state says something', () => {
  it.each(SECTION_STATES)('%s renders words, not an empty card', (state) => {
    const html = render(
      <SectionCard section={section('issues', { state: state as SectionState, records: [], count: 0 })} />,
    )
    const text = textOf(html).trim()

    expect(text.length).toBeGreaterThan(20)
    expect(text).toContain('Issues')
  })

  it('distinguishes "there is nothing" from "we could not find out"', () => {
    const empty = textOf(render(<SectionCard section={section('issues', { state: 'empty', records: [], count: 0 })} />))
    const unavailable = textOf(
      render(
        <SectionCard
          section={section('issues', {
            state: 'unavailable',
            records: [],
            count: 0,
            reason: 'the source could not be reached',
            provenance: null,
          })}
        />,
      ),
    )

    expect(empty).toContain('nothing recorded')
    expect(empty).toContain('read successfully')
    expect(unavailable).toContain('could not be reached')
    expect(unavailable).not.toContain('read successfully')
    expect(empty).not.toBe(unavailable)
  })

  it('names the parts of a partial section that did not answer', () => {
    const html = render(
      <SectionCard
        section={section('activity', {
          state: 'partial',
          reason: 'one part of this section could not be fetched',
          missing: ['lane2'],
        })}
      />,
    )

    expect(textOf(html)).toContain('lane2')
    expect(textOf(html)).toContain('Not included')
  })
})

/* ── forbidden discloses nothing ───────────────────────────────────────────*/

describe('a forbidden section is silent about what is behind it', () => {
  const html = render(
    <SectionCard
      section={section('opportunities', {
        state: 'forbidden',
        // Deliberately supplied, to prove the view discards them rather than
        // relying on the API having stripped them.
        count: 17,
        reason: 'you are not on this account team',
        provenance: { source: 'odoo:crm.lead', fetchedAt: '2026-08-01T12:00:00.000Z', stale: false },
        records: [{ id: 5, name: 'A deal you may not see' }],
      })}
    />,
  )

  it('shows no count', () => {
    expect(textOf(html)).not.toContain('17')
  })

  it('shows no reason', () => {
    expect(textOf(html)).not.toContain('account team')
  })

  it('shows no provenance and no record', () => {
    expect(textOf(html)).not.toContain('crm.lead')
    expect(textOf(html)).not.toContain('A deal you may not see')
  })

  it('says only that it is not available', () => {
    expect(textOf(html)).toContain('do not have access')
  })
})

/* ── the lifecycle ─────────────────────────────────────────────────────────*/

describe('every lifecycle state is rendered and distinguishable', () => {
  it('renders all fourteen', () => {
    expect(ACTION_LIFECYCLE_STATES).toHaveLength(14)
    for (const state of ACTION_LIFECYCLE_STATES) {
      const html = render(<LifecycleBadge state={state} />)
      expect(html).toContain(`data-lifecycle="${state}"`)
      expect(textOf(html)).toContain(LIFECYCLE_PRESENTATION[state].label)
    }
  })

  it('gives every state a distinct label', () => {
    const labels = ACTION_LIFECYCLE_STATES.map((s) => LIFECYCLE_PRESENTATION[s].label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('never conveys a state by colour alone', () => {
    for (const state of ACTION_LIFECYCLE_STATES) {
      const html = render(<LifecycleBadge state={state} />)
      // A marker and a word, both present, independent of any styling.
      expect(textOf(html).trim().length).toBeGreaterThan(3)
      expect(textOf(html)).not.toMatch(/\b(red|green|amber|yellow)\b/i)
    }
  })
})

const outcome = (over: Partial<ActionOutcomeView> = {}): ActionOutcomeView => {
  const lifecycle = (over.lifecycle ?? 'completed_verified') as ActionLifecycleState
  const p = LIFECYCLE_PRESENTATION[lifecycle]
  return {
    actionType: 'note.create',
    lifecycle,
    success: p.success,
    label: p.label,
    detail: p.sentence,
    marker: p.marker,
    tone: p.tone,
    terminal: p.terminal,
    retryWrite: p.retryWrite,
    retryReadback: p.retryReadback,
    escalate: p.escalate,
    showsPriorResult: p.showsPriorResult,
    operationId: 'op_abc',
    auditRef: 'op_abc',
    readbackProven: lifecycle === 'completed_verified',
    approvalRef: null,
    ...over,
  }
}

describe('readback_failed never reads as done', () => {
  const html = render(<ActionResult outcome={outcome({ lifecycle: 'readback_failed' })} />)

  it('is marked as unsuccessful in the markup', () => {
    expect(html).toContain('data-success="false"')
    expect(html).toContain('data-action-result="readback_failed"')
  })

  it('carries no tick', () => {
    expect(html).not.toContain('✓')
  })

  it('says a write may have happened and cannot be proven', () => {
    const text = textOf(html)
    expect(text).toContain('Written but not confirmed')
    expect(text).toContain('not confirmed')
    expect(text).toContain('check the system of record')
  })

  it('says re-sending is not safe', () => {
    expect(textOf(html)).toContain('not safe')
  })

  it('is announced assertively, because it should not be discovered by chance', () => {
    expect(html).toContain('aria-live="assertive"')
  })
})

/* ── the defect live acceptance found ──────────────────────────────────────*/

describe('retry advice belongs to the STATE, not to the flag', () => {
  it('does not warn a rejected action that it might write a second time', () => {
    // The live defect: "Rejected before sending" sat directly above
    // "not safe — it may write a second time". Nothing was sent.
    const text = textOf(render(<ActionResult outcome={outcome({ lifecycle: 'validation_failed' })} />))

    expect(text).not.toContain('may write a second time')
    expect(text).toContain('nothing was written')
  })

  it('warns ONLY readback_failed that a write could repeat', () => {
    const warned = ACTION_LIFECYCLE_STATES.filter((state) =>
      textOf(render(<ActionResult outcome={outcome({ lifecycle: state })} />)).includes(
        'may write a second time',
      ),
    )

    expect(warned).toEqual(['readback_failed'])
  })

  it('keeps the contract sentence when a more specific detail is also supplied', () => {
    // The validator's wording is useful, but it must not displace the words
    // that say whether anything was written.
    const text = textOf(
      render(
        <ActionResult
          outcome={outcome({ lifecycle: 'validation_failed', detail: 'body is required' })}
        />,
      ),
    )

    expect(text).toContain('body is required')
    expect(text).toContain('Nothing was written')
  })

  it('does not repeat itself when the detail IS the contract sentence', () => {
    const state: ActionLifecycleState = 'execution_failed'
    const sentence = LIFECYCLE_PRESENTATION[state].sentence
    const text = textOf(render(<ActionResult outcome={outcome({ lifecycle: state, detail: sentence })} />))

    expect(text.split(sentence.slice(0, 30)).length - 1).toBe(1)
  })
})

describe('unreachable and refused do not look the same', () => {
  const unreachable = render(<ActionResult outcome={outcome({ lifecycle: 'dependency_unavailable' })} />)
  const refused = render(<ActionResult outcome={outcome({ lifecycle: 'execution_failed' })} />)

  it('uses different words', () => {
    expect(textOf(unreachable)).toContain('never received this')
    expect(textOf(refused)).toContain('rejected this')
  })

  it('gives opposite retry advice', () => {
    expect(textOf(unreachable)).toContain('safe — nothing was written')
    expect(textOf(refused)).toContain('not safe')
  })

  it('marks neither as a success', () => {
    expect(unreachable).toContain('data-success="false"')
    expect(refused).toContain('data-success="false"')
  })
})

describe('only a verified readback reads as done', () => {
  it('is the single state whose markup says success', () => {
    const succeeded = ACTION_LIFECYCLE_STATES.filter((state) =>
      render(<ActionResult outcome={outcome({ lifecycle: state })} />).includes('data-success="true"'),
    )
    expect(succeeded).toEqual(['completed_verified'])
  })

  it('says plainly whether the record was read back', () => {
    expect(textOf(render(<ActionResult outcome={outcome({ lifecycle: 'completed_verified' })} />))).toContain(
      'yes — this is confirmed',
    )
    expect(textOf(render(<ActionResult outcome={outcome({ lifecycle: 'readback_failed' })} />))).toContain(
      'no — this is not confirmed',
    )
  })

  it('returns the shared ledger reference for an operation that reached it', () => {
    expect(textOf(render(<ActionResult outcome={outcome()} />))).toContain('op_abc')
  })

  it('says a replay belongs to an earlier attempt', () => {
    expect(textOf(render(<ActionResult outcome={outcome({ lifecycle: 'idempotent_replay' })} />))).toContain(
      'earlier attempt',
    )
  })
})

/* ── the workbench before it sends ─────────────────────────────────────────*/

describe('the workbench describes the write before anything is sent', () => {
  const html = render(<CustomerWorkspaceView {...props({ selectedAction: 'note.create' })} />)
  const text = textOf(html)

  it('names the customer, the action, the target system and the risk', () => {
    expect(text).toContain('Marigot Hardware')
    expect(text).toContain('Add a note')
    expect(text).toContain('system of record')
    expect(text).toContain('Risk')
  })

  it('says what will be written and what proof will be required', () => {
    expect(text).toContain('Records a note against this customer')
    expect(text).toContain('read back from the system of record before it is reported as done')
  })

  it('states the required permission and whether approval is needed', () => {
    expect(text).toContain('Required permission')
    expect(text).toContain('no separate approval is required')
  })

  it('says what happens if it goes wrong', () => {
    expect(text).toContain('If it goes wrong')
    expect(text).toContain('will not be undone automatically')
  })

  it('wires every field label to its control', () => {
    expect(html).toContain('for="action-field-body"')
    expect(html).toContain('id="action-field-body"')
  })

  it('offers a real button rather than something only a mouse can reach', () => {
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
  })

  it('marks the approval-gated action in its own control', () => {
    expect(text).toContain('Update a lead (needs approval)')
  })

  it('sizes touch targets in CSS rather than claiming them in a comment', () => {
    expect(html).toContain('min-h-11')
  })
})

/* ── the whole screen ──────────────────────────────────────────────────────*/

describe('the workspace screen', () => {
  it('renders all twelve sections', () => {
    const html = render(<CustomerWorkspaceView {...props()} />)
    for (const name of CONTEXT_SECTION_NAMES) {
      expect(html).toContain(`data-section="${name}"`)
    }
  })

  it('renders all twelve sections REGARDLESS of which tab is selected -- a tab hides visually, it never removes markup', () => {
    for (const tab of ['sales', 'billing', 'tickets', 'openWork', 'activity', 'services'] as const) {
      const html = render(<CustomerWorkspaceView {...props({ selectedTab: tab })} />)
      for (const name of CONTEXT_SECTION_NAMES) {
        expect(html).toContain(`data-section="${name}"`)
      }
    }
  })

  it('marks exactly one tab panel visible (not aria-hidden) at a time, matching selectedTab', () => {
    const html = render(<CustomerWorkspaceView {...props({ selectedTab: 'billing' })} />)
    // Attributes are checked independently rather than as one combined
    // string, since JSX prop order (not test-author assumption) governs
    // the exact serialized attribute order.
    const panel = (tab: string) => {
      const start = html.indexOf(`data-tab-panel="${tab}"`)
      // Each panel <div ...> opens with role="tabpanel" aria-hidden={...}
      // data-tab-panel={...} -- slice back far enough to capture aria-hidden.
      return html.slice(Math.max(0, start - 40), start + 40)
    }
    expect(panel('billing')).toContain('aria-hidden="false"')
    expect(panel('sales')).toContain('aria-hidden="true"')
    expect(panel('tickets')).toContain('aria-hidden="true"')
    expect(panel('openWork')).toContain('aria-hidden="true"')
    expect(panel('activity')).toContain('aria-hidden="true"')
    expect(panel('services')).toContain('aria-hidden="true"')
  })

  it('renders all six tabs with aria-selected marking only the active one', () => {
    const html = render(<CustomerWorkspaceView {...props({ selectedTab: 'activity' })} />)
    for (const tab of ['sales', 'billing', 'tickets', 'openWork', 'activity', 'services']) {
      expect(html).toContain(`data-tab="${tab}"`)
    }
    const button = (tab: string) => {
      const start = html.indexOf(`data-tab="${tab}"`)
      return html.slice(Math.max(0, start - 40), start + 10)
    }
    expect(button('activity')).toContain('aria-selected="true"')
    expect(button('sales')).toContain('aria-selected="false"')
  })

  it('keeps the customer identity section OUTSIDE every tab panel -- always visible, never gated', () => {
    const html = render(<CustomerWorkspaceView {...props({ selectedTab: 'billing' })} />)
    // The customer SectionCard must appear before the first tab panel in
    // document order, i.e. outside the tabbed body entirely.
    const customerIndex = html.indexOf('data-section="customer"')
    const firstTabPanelIndex = html.indexOf('data-tab-panel=')
    expect(customerIndex).toBeGreaterThan(-1)
    expect(firstTabPanelIndex).toBeGreaterThan(-1)
    expect(customerIndex).toBeLessThan(firstTabPanelIndex)
  })

  it('places the two native surfaces inside the Tickets tab panel, not floating outside any tab', () => {
    const html = render(<CustomerWorkspaceView {...props({ selectedTab: 'tickets' })} />)
    const ticketsOpen = html.indexOf('data-tab-panel="tickets"')
    const ticketsClose = html.indexOf('data-tab-panel="openWork"') // next panel in TAB_ORDER
    const ticketsSection = html.slice(ticketsOpen, ticketsClose)
    expect(ticketsSection).toContain('data-native-surface="chatwoot"')
    expect(ticketsSection).toContain('data-native-surface="clawith"')
  })

  it('states once, at the top, that the picture is incomplete and names what is missing', () => {
    const context = response({
      provenance: {
        generatedAt: '2026-08-01T12:00:00.000Z',
        degraded: ['invoices', 'pbx'],
        forbiddenCount: 0,
        sectionCount: 12,
      },
    })
    const text = textOf(render(<CustomerWorkspaceView {...props({ context })} />))

    expect(text).toContain('incomplete picture')
    expect(text).toContain('Invoices')
    expect(text).toContain('PBX')
  })

  it('renders both read-only native surfaces, unavailable and without a link', () => {
    const html = render(<CustomerWorkspaceView {...props()} />)

    expect(html).toContain('data-native-surface="chatwoot"')
    expect(html).toContain('data-native-surface="clawith"')
    expect(textOf(html)).toContain('This panel is read-only')
    const surfaces = render(
      <NativeSurface name="Conversations" system="chatwoot" reason="No authoritative reference." />,
    )
    expect(surfaces).not.toContain('<a ')
  })

  it('renders a link only when the record arrived with one', () => {
    const withLink = response()
    withLink.sections.customer = section('customer', {
      records: [{ id: 42, name: 'Marigot Hardware', link: 'https://tenant.odoo.com/odoo/res.partner/42' }],
    })
    const without = response()

    expect(render(<CustomerWorkspaceView {...props({ context: withLink })} />)).toContain(
      'https://tenant.odoo.com/odoo/res.partner/42',
    )
    expect(render(<CustomerWorkspaceView {...props({ context: without })} />)).not.toContain('/odoo/res.partner/42')
  })

  it('does not offer a composer, a message timeline or a takeover control', () => {
    const text = textOf(render(<CustomerWorkspaceView {...props({ selectedAction: 'note.create' })} />)).toLowerCase()

    expect(text).not.toContain('send message')
    expect(text).not.toContain('reply')
    expect(text).not.toContain('take over')
    expect(text).not.toContain('hand back')
  })

  it('tells a reader whose workspace could not be read that nothing has changed', () => {
    const text = textOf(render(<CustomerWorkspaceView {...props({ status: 'error', context: null })} />))

    expect(text).toContain('Nothing about this customer has changed')
    expect(text).toContain('Try again')
  })

  it('uses one wording for absent and for not-yours', () => {
    const text = textOf(render(<CustomerWorkspaceView {...props({ status: 'not_found', context: null })} />))
    expect(text).toContain('not found, or is not available to you')
  })

  it('carries no fixture or placeholder content', () => {
    const text = textOf(render(<CustomerWorkspaceView {...props()} />))
    expect(text).not.toMatch(/lorem|placeholder|john doe|acme|example\.com/i)
  })
})
