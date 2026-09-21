/**
 * Reverse navigation from the Services tab back to the Personal Lines
 * surface (owner, 2026-09-20: "Personal Lines list -> customer workspace ->
 * Services -> selected Personal Line, and the reverse navigation").
 *
 * The view renders the reverse links ONLY when the container supplies the
 * callbacks — the same rule `onBackToCustomers` already follows, because a
 * dead-end link is worse than none. Both directions are asserted: present
 * when supplied (with the row's `did` carried on the element), absent when
 * not (the control that the presence assertion can fail).
 *
 * This workspace has no jsdom, so these are render-level assertions via
 * renderToStaticMarkup — the same level the c360 checkpoint scripts use.
 * The click handlers are one-line closures (`onOpenPersonalLine(s.did)`),
 * reviewed, not clicked here.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CustomerWorkspaceView } from './workspace-view'
import type { Customer360Snapshot } from '../../lib/customer-360/contracts'

const noop = () => {}

const snapshot: Customer360Snapshot = {
  verifiedAt: '2026-09-21T12:00:00.000Z',
  freshness: 'fresh',
  conversation: { displayId: 1, currentRequest: null },
  customer: {
    id: 3037,
    name: 'Linked Customer',
    email: null,
    phone: '+17675550101',
    city: null,
    isCompany: false,
    companyName: null,
    customerSince: '2026-09-18 00:00:00',
    tags: [],
  },
  balances: [],
  lifetimeValue: [],
  followUps: [],
  followUpsAvailable: true,
  services: [
    { kind: 'personal_line', did: '17678185064', sipRegistered: false, magnusUserAssigned: true, createdAt: '2026-09-18T00:00:00.000Z', lifecycle: null },
    { kind: 'personal_line', did: '17678185073', sipRegistered: null, magnusUserAssigned: false, createdAt: null, lifecycle: null },
  ],
  servicesAvailable: true,
  timeline: [],
  timelineCallsNote: 'Calls are not shown in this fixture.',
  documents: [],
  openLoops: [],
  openLoopsAvailable: true,
  recommendedAction: null,
}

const commonProps = {
  snapshot,
  tab: 'services' as const,
  onTabChange: noop,
  nested: null,
  onOpenObject: noop,
  onCloseObject: noop,
  lifecycleDrillDown: null,
  onOpenLifecycle: noop,
  onCloseLifecycle: noop,
  outcomeFor: () => undefined,
  send: null,
  onSendOpen: noop,
  onSendConfirm: noop,
  onSendClose: noop,
  replyOpen: false,
  onReplyOpen: noop,
  onReplyClose: noop,
  destinationLabel: null,
}

describe('Services tab reverse navigation to Personal Lines', () => {
  it('renders the list link and one per-line link carrying that line\'s did when the container supplies both callbacks', () => {
    const html = renderToStaticMarkup(
      <CustomerWorkspaceView {...commonProps} onOpenPersonalLines={noop} onOpenPersonalLine={noop} />,
    )
    expect(html).toContain('data-reverse-nav="personal-lines"')
    expect(html).toContain('Personal Lines')
    expect(html).toContain('data-reverse-nav="personal-line" data-did="17678185064"')
    expect(html).toContain('data-reverse-nav="personal-line" data-did="17678185073"')
    expect(html.match(/data-reverse-nav="personal-line"/g)).toHaveLength(2)
    // The identifier carried is the did and only the did — never a bff-v2 join key.
    expect(html).not.toMatch(/liteAccountId/)
  })

  it('CONTROL: renders neither link when the container supplies no callbacks — a dead-end link is worse than none', () => {
    const html = renderToStaticMarkup(<CustomerWorkspaceView {...commonProps} />)
    expect(html).not.toContain('data-reverse-nav=')
    expect(html).not.toContain('Open in Personal Lines')
    // The panel itself still rendered — the absence above is the links, not the tab.
    expect(html).toContain('17678185064')
  })

  it('the two callbacks are independent: list link without per-line links, and the reverse', () => {
    const listOnly = renderToStaticMarkup(<CustomerWorkspaceView {...commonProps} onOpenPersonalLines={noop} />)
    expect(listOnly).toContain('data-reverse-nav="personal-lines"')
    expect(listOnly).not.toContain('data-reverse-nav="personal-line"')

    const lineOnly = renderToStaticMarkup(<CustomerWorkspaceView {...commonProps} onOpenPersonalLine={noop} />)
    expect(lineOnly).not.toContain('data-reverse-nav="personal-lines"')
    expect(lineOnly.match(/data-reverse-nav="personal-line"/g)).toHaveLength(2)
  })
})
