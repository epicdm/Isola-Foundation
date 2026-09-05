/**
 * Identity bar checkpoint — item 1 of the owner's 2026-09-05 three-item
 * follow-up. Renders CustomerWorkspaceView (components/customer-360, the
 * component actually embedded live in Chatwoot at conv #15) to static HTML
 * and writes it to disk, so the new chrome can be screenshotted WITHOUT
 * deploying to isola360uat -- that stack belongs to the release lane per the
 * owner's explicit correction this same day.
 *
 * DATA PROVENANCE: fetched live 2026-09-05 via POST /api/isola-360/context
 * {"customerId":163} against the already-deployed 5e6b18fa build (a READ,
 * not a redeploy) -- Patricia "Yvonne" Armour, conversation #15. tags: []
 * and companyName: null are her REAL values, not omitted for convenience:
 * she genuinely carries no res.partner.category_id tags today, which is why
 * the identity bar's tag row is built to render conditionally rather than
 * assumed to always have content.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { CustomerWorkspaceView } from '../components/customer-360/workspace-view'
import styles from '../components/customer-360/customer-360.module.css'
import type { Customer360Snapshot, Customer360ObjectDetail } from '../lib/customer-360/contracts'

/**
 * The raw stylesheet uses literal class names (`.identityBar`); the rendered
 * markup uses vitest's HASHED CSS-module names. Same bridge
 * render-c360-checkpoint.test.tsx already uses for the other lineage, but
 * driven from the CSS file itself rather than a hand-maintained list, so a
 * class added later cannot silently fall out of sync with this script.
 */
function inlinedCss(rawCss: string): string {
  return rawCss.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)\b/g, (match, name: string) => {
    const resolved = (styles as Record<string, string>)[name]
    return resolved ? `.${resolved}` : match
  })
}

const armour: Customer360Snapshot = {
  verifiedAt: '2026-09-05T02:57:35.213Z',
  freshness: 'fresh',
  conversation: { displayId: 15, currentRequest: null },
  customer: {
    id: 163,
    name: 'Patricia Yvonne Armour',
    email: 'yvonne.armour07@gmail.com',
    phone: '+17672951770',
    city: 'Spring Field',
    isCompany: false,
    companyName: null,
    customerSince: '2026-02-14 04:25:36',
    tags: [],
  },
  balances: [],
  lifetimeValue: [],
  followUps: [],
  followUpsAvailable: true,
  timeline: [],
  timelineCallsNote: 'Calls are not shown: Magnus CDR data lives on bff-v2, not Foundation, and no server-to-server read path exists yet.',
  documents: [
    {
      id: 607,
      reference: 'S00670',
      kind: 'quotation',
      state: 'draft',
      total: 4272.6,
      currency: 'XCD',
      date: '2026-07-10 15:21:20',
      odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/607',
    },
  ],
  openLoops: [
    {
      id: 1381,
      title: 'Re: Update to Cheque Payment Details',
      kind: 'task',
      state: null,
      due: null,
      odooLink: null,
    },
  ],
  openLoopsAvailable: true,
  recommendedAction: {
    kind: 'review-draft-quotation',
    headline: 'Review quotation S00670 and ask the customer whether they would like to proceed or request changes.',
    document: {
      id: 607,
      reference: 'S00670',
      kind: 'quotation',
      state: 'draft',
      total: 4272.6,
      currency: 'XCD',
      date: '2026-07-10 15:21:20',
      odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/607',
    },
    reasoning: 'S00670 is a draft quotation for Patricia Yvonne Armour — it has not been sent, approved or accepted. Confirming intent before any further action avoids acting on a stale or unreviewed document.',
    suggestedReply: "Hi Patricia, I've reviewed quotation S00670 for XCD 4,272.60. Would you like to proceed, or is there anything you'd like adjusted?",
  },
}

/**
 * S00670, fetched live 2026-09-05 via POST /api/isola-360/objects against
 * conv #15's real hint ({accountIdHint:2, inboxIdHint:7,
 * conversationDisplayIdHint:15}) -- a READ against the already-deployed
 * 5e6b18fa build, not a redeploy. Real stage rail: Quotation (current),
 * Confirmed (upcoming), Invoiced (upcoming) -- the honest three-stage rail
 * this codebase already derives from real sale.order fields (state,
 * invoice_status), not the reference's five-stage Deal→Order→Fulfilled→
 * Invoiced→Paid, because "Fulfilled" would need stock.picking, which this
 * Odoo instance does not have installed. Line 1's label is real but long
 * (340 chars, a copy-pasted hardware spec sheet); truncated here for the
 * checkpoint page only, not in the component.
 */
const s00670Detail: Customer360ObjectDetail = {
  kind: 'quotation',
  id: 607,
  reference: 'S00670',
  state: 'draft',
  paymentState: null,
  total: 4272.6,
  currency: 'XCD',
  date: '2026-07-10 15:21:20',
  dueDate: null,
  odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/607',
  stages: [
    { key: 'quotation', label: 'Quotation', state: 'current' },
    { key: 'confirmed', label: 'Confirmed', state: 'upcoming' },
    { key: 'invoiced', label: 'Invoiced', state: 'upcoming' },
  ],
  lines: [
    { id: 1286, label: '[HP] Hardware Purchase — Lenovo Laptop V15 G4 (truncated, real label is 340 chars)', quantity: 1, unitPrice: 4139.1, subtotal: 4139.1 },
    { id: 1287, label: '[SWP] SOFTWARE PURCHASE — Microsoft Office 2024 Pro License', quantity: 1, unitPrice: 133.5, subtotal: 133.5 },
  ],
  linesAvailability: 'available',
  payments: [],
  paymentsAvailability: 'available',
}

/** A second fixture with tags and a company, so the identity bar's
 *  conditional rendering is proven to actually render something, not just
 *  proven to hide correctly. Values are plausible, not claimed as real Odoo
 *  data — labelled as such in the checkpoint page itself. */
const withTagsAndCompany: Customer360Snapshot = {
  ...armour,
  customer: {
    ...armour.customer,
    id: 9001,
    name: 'Marisol Vega',
    companyName: 'Café Andino',
    tags: ['Wholesale', 'VIP'],
  },
}

describe('identity bar checkpoint (render only, no deploy)', () => {
  it('writes the checkpoint page to disk', () => {
    const rawCss = readFileSync(path.resolve(__dirname, '../components/customer-360/customer-360.module.css'), 'utf8')

    const noop = () => {}
    const commonProps = {
      tab: 'overview' as const,
      onTabChange: noop,
      nested: null,
      onOpenObject: noop,
      onCloseObject: noop,
      outcomeFor: () => undefined,
      send: null,
      onSendOpen: noop,
      onSendConfirm: noop,
      onSendClose: noop,
      onReplyClose: noop,
      destinationLabel: 'conversation #15',
    }

    const armourMarkup = renderToStaticMarkup(
      <CustomerWorkspaceView {...commonProps} snapshot={armour} replyOpen={false} onReplyOpen={noop} onBackToCustomers={noop} />,
    )
    const taggedMarkup = renderToStaticMarkup(
      <CustomerWorkspaceView {...commonProps} snapshot={withTagsAndCompany} replyOpen={false} onReplyOpen={noop} onBackToCustomers={noop} />,
    )
    const nestedMarkup = renderToStaticMarkup(
      <CustomerWorkspaceView
        {...commonProps}
        tab="sales"
        snapshot={armour}
        nested={{ target: { kind: 'quotation', id: 607, reference: 'S00670' }, phase: { kind: 'ready', detail: s00670Detail } }}
        replyOpen={false}
        onReplyOpen={noop}
        onBackToCustomers={noop}
      />,
    )

    expect(armourMarkup).toContain('Patricia Yvonne Armour')
    expect(armourMarkup).toContain('PA') // initials, no company/tags for this real customer
    expect(taggedMarkup).toContain('Café Andino')
    expect(taggedMarkup).toContain('Wholesale')
    expect(nestedMarkup).toContain('S00670')
    expect(nestedMarkup).toContain('Quotation') // current stage, not fabricated as "Draft"
    expect(nestedMarkup).toContain('Message') // primary verb, not "Open in Odoo"

    const css = inlinedCss(rawCss)
    const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Identity bar + nested object checkpoint — 2026-09-05</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #ddd; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; }
  .frame { width: 1091px; margin: 24px auto; box-shadow: 0 0 0 1px #0002; }
  .caption { max-width: 1091px; margin: 0 auto 4px; font: 12px monospace; color: #555; }
</style>
</head>
<body>
  <p class="caption">(a) Identity bar — real Odoo data, Patricia Yvonne Armour (partner 163, conv #15). No company/tags: her real values.</p>
  <div class="frame">${armourMarkup}</div>
  <p class="caption">Illustrative only — proves tags/company render when present. Not this customer's real record.</p>
  <div class="frame">${taggedMarkup}</div>
  <p class="caption">(b) S00670 opened as a NESTED record, Sales tab — real Odoo data via /api/isola-360/objects. Stage rail: Quotation (current) — the honest equivalent of "Draft" for a sale.order this codebase already derives from real state/invoice_status fields.</p>
  <div class="frame">${nestedMarkup}</div>
</body>
</html>`

    const outDir = path.resolve(__dirname, '../../../.checkpoints')
    mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, 'c360-identity-bar-2026-09-05.html')
    writeFileSync(outPath, page, 'utf8')
  })
})
