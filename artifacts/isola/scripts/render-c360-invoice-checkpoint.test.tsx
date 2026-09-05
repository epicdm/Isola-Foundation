/**
 * Invoice checkpoint — items 2 (invoice nested pattern) and 3 (per-object
 * composer pre-fill) of the owner's 2026-09-05 follow-up. Renders
 * CustomerWorkspaceView to static HTML, no isola360uat deploy (release lane
 * territory, per the owner's process correction earlier this same day).
 *
 * DATA PROVENANCE: fetched live 2026-09-05 via POST /api/isola-360/context
 * {"customerId":835} against the already-deployed 5e6b18fa build (a READ,
 * not a redeploy) -- NTRC (National Telecommunications Regulatory
 * Commission), invoice INV/2026/00044 (id 412): state posted, payment_state
 * partial, total XCD 336,130, residual XCD 201,678, dated 2026-08-28.
 *
 * WHAT IS AND ISN'T INDEPENDENTLY VERIFIED: the header figures above came
 * from the context read, which this codebase's own honesty rule treats as
 * real. The LINE ITEMS and PAYMENTS ledger were NOT independently re-fetched
 * for this fixture -- /api/isola-360/objects requires a Chatwoot hint tied
 * to a real conversation, and no such conversation is known for NTRC outside
 * conv #15 (which belongs to a different customer, Yvonne Armour, who has no
 * real invoice to demonstrate with). The invoice's own real header fields
 * (state/paymentState/total/currency/date) are used as-is; `lines` below are
 * placeholder rows, explicitly labelled as such on the page -- never
 * presented as this invoice's real line items.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { CustomerWorkspaceView } from '../components/customer-360/workspace-view'
import styles from '../components/customer-360/customer-360.module.css'
import type { Customer360Snapshot, Customer360ObjectDetail } from '../lib/customer-360/contracts'

function inlinedCss(rawCss: string): string {
  return rawCss.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)\b/g, (match, name: string) => {
    const resolved = (styles as Record<string, string>)[name]
    return resolved ? `.${resolved}` : match
  })
}

const ntrc: Customer360Snapshot = {
  verifiedAt: '2026-09-05T04:00:00.000Z',
  freshness: 'fresh',
  conversation: { displayId: null, currentRequest: null },
  customer: {
    id: 835,
    name: 'NTRC - National Telecommunications Regulatory Commission',
    email: 'secretariat@ntrc.dm',
    phone: '+1 767-276-0627',
    city: 'Roseau',
    isCompany: true,
    companyName: null,
    customerSince: '2026-02-23 17:41:34',
    tags: [],
  },
  balances: [{ currency: 'XCD', amount: 539930.97 }],
  lifetimeValue: [{ currency: 'XCD', amount: 336130 }],
  followUps: [],
  followUpsAvailable: true,
  timeline: [],
  timelineCallsNote: 'Calls are not shown: Magnus CDR data lives on bff-v2, not Foundation, and no server-to-server read path exists yet.',
  documents: [
    {
      id: 412,
      reference: 'INV/2026/00044',
      kind: 'invoice',
      state: 'posted',
      paymentState: 'partial',
      total: 336130,
      residual: 201678,
      currency: 'XCD',
      date: '2026-08-28',
      odooLink: 'https://epic-communications-inc.odoo.com/odoo/account.move/412',
    },
  ],
  openLoops: [],
  openLoopsAvailable: true,
  recommendedAction: null,
}

/**
 * Real header fields (see file docstring); `lines`/`payments` are
 * PLACEHOLDER rows, not this invoice's real ledger -- marked as such in the
 * page caption, never silently presented as fetched data.
 */
const inv412Detail: Customer360ObjectDetail = {
  kind: 'invoice',
  id: 412,
  reference: 'INV/2026/00044',
  state: 'posted',
  paymentState: 'partial',
  total: 336130,
  currency: 'XCD',
  date: '2026-08-28',
  dueDate: null,
  odooLink: 'https://epic-communications-inc.odoo.com/odoo/account.move/412',
  // Draft -> Posted -> Part paid -> Paid, derived the same way
  // invoiceStages(state, paymentState) already computes it for a real
  // posted+partial invoice: Draft and Posted are done, Part paid is
  // current, Paid is upcoming.
  stages: [
    { key: 'draft', label: 'Draft', state: 'done' },
    { key: 'posted', label: 'Posted', state: 'done' },
    { key: 'part-paid', label: 'Part paid', state: 'current' },
    { key: 'paid', label: 'Paid', state: 'upcoming' },
  ],
  lines: [
    { id: 1, label: 'PLACEHOLDER — not independently fetched for this checkpoint', quantity: 1, unitPrice: 336130, subtotal: 336130 },
  ],
  linesAvailability: 'available',
  payments: [
    { id: 1, amount: 134452, currency: 'XCD', date: '2026-08-30', reference: 'PLACEHOLDER — not independently fetched' },
  ],
  paymentsAvailability: 'available',
}

describe('invoice + composer checkpoint (render only, no deploy)', () => {
  it('writes the checkpoint page to disk', () => {
    const rawCss = readFileSync(path.resolve(__dirname, '../components/customer-360/customer-360.module.css'), 'utf8')

    const noop = () => {}
    const commonProps = {
      tab: 'billing' as const,
      onTabChange: noop,
      onOpenObject: noop,
      onCloseObject: noop,
      outcomeFor: () => undefined,
      send: null,
      onSendOpen: noop,
      onSendConfirm: noop,
      onSendClose: noop,
      onReplyClose: noop,
      destinationLabel: 'NTRC — no linked conversation',
    }

    const prefill = 'About invoice INV/2026/00044: '

    const nestedMarkup = renderToStaticMarkup(
      <CustomerWorkspaceView
        {...commonProps}
        snapshot={ntrc}
        nested={{ target: { kind: 'invoice', id: 412, reference: 'INV/2026/00044' }, phase: { kind: 'ready', detail: inv412Detail } }}
        replyOpen={false}
        onReplyOpen={noop}
        onBackToCustomers={noop}
      />,
    )

    // The composer, opened AS IF the invoice's Message button had just been
    // clicked -- same component, same prop the real click sets.
    const composerMarkup = renderToStaticMarkup(
      <CustomerWorkspaceView
        {...commonProps}
        snapshot={ntrc}
        nested={{ target: { kind: 'invoice', id: 412, reference: 'INV/2026/00044' }, phase: { kind: 'ready', detail: inv412Detail } }}
        replyOpen={true}
        replyPrefill={prefill}
        onReplyOpen={noop}
        onBackToCustomers={noop}
      />,
    )

    expect(nestedMarkup).toContain('INV/2026/00044')
    expect(nestedMarkup).toContain('Part paid') // current stage, real state+payment_state
    expect(nestedMarkup).toContain('Message') // leads, before "Open in Odoo"
    expect(composerMarkup).toContain(prefill) // the exact pre-filled text, in the draft textarea

    const css = inlinedCss(rawCss)
    const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice + composer checkpoint — 2026-09-05</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #ddd; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; }
  /* transform creates a containing block, so the composer's position:fixed
     overlay (correctly fixed to the VIEWPORT in the real app, which has
     only one frame) stays scoped to its own .frame here, where two frames
     share one page. */
  .frame { width: 1091px; margin: 24px auto; box-shadow: 0 0 0 1px #0002; position: relative; min-height: 200px; transform: translateZ(0); }
  .caption { max-width: 1091px; margin: 0 auto 4px; font: 12px monospace; color: #555; }
</style>
</head>
<body>
  <p class="caption">(2) INV/2026/00044 opened as a NESTED record, Billing tab — real header fields (NTRC, partner 835). Stage rail: Draft/Posted done, Part paid current, Paid upcoming — from real state=posted + payment_state=partial. Lines/payments below are PLACEHOLDER rows (see file docstring) — not this invoice's real ledger.</p>
  <div class="frame">${nestedMarkup}</div>
  <p class="caption">(3) Message clicked from this invoice — composer opens pre-filled with "About invoice INV/2026/00044: ", the design's quickMessage pattern, via the existing prepare-reply dialog (real and wired, not a second composer).</p>
  <div class="frame">${composerMarkup}</div>
</body>
</html>`

    const outDir = path.resolve(__dirname, '../../../.checkpoints')
    mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, 'c360-invoice-composer-2026-09-05.html')
    writeFileSync(outPath, page, 'utf8')
  })
})
