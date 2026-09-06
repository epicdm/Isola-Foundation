/**
 * Owner checkpoint, Steps A-D (dec-c360-design-defines-the-target-find-the-
 * data-2026-09-04 build order, plus the owner's 2026-09-04 "run B-E straight
 * through" follow-up): render every screenshot the build order asks for and
 * write HTML to disk.
 *
 * DATA PROVENANCE — every scenario says where its data came from:
 *   - Yvonne Armour (partner 163) and NTRC (partner 835): real Odoo data,
 *     fetched via deepseek in the Step A pass. See record-detail-data.json
 *     and c360-checkpoint-data.json.
 *   - Gregory Royer (partner 2898) and the day-one signup (partner 2945):
 *     real Odoo data, fetched the same way for this pass specifically —
 *     see quiet-and-dayone-data.json's own header for how each was found
 *     (a live query for "openOrders=0, unpaidInvoices=0, riskyTickets=0,
 *     openDeals=0" for Gregory; "zero orders/invoices/deals, created two
 *     days ago" for the day-one signup).
 *   - The aging-bucket demo and the degraded-states demo are the two
 *     EXCEPTIONS: both are SYNTHETIC, clearly marked as such in their own
 *     section below and in the owner report. No real fixture customer in
 *     this Odoo instance has enough invoices (3, at most) to show a
 *     collapsed bucket, and fabricating a real customer's "unavailable"
 *     state would misrepresent an outage that isn't happening. Every
 *     invoice in the synthetic set still uses real field shapes and real
 *     computation (agingBucketFor, imported from the component under test,
 *     not reimplemented) — only the numbers are made up, and they are
 *     labelled as such on the page itself.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CustomerWorkspaceView,
  type RecordLineItem,
  type ConversationResolutionView,
} from '../components/customer/workspace-view'
import styles from '../components/customer/workspace-view.module.css'
import type { ContextSectionEnvelope, ContextSectionName, CustomerContextResponse } from '../lib/context/customer-context'
import { CALLS_NOT_CONNECTED_REASON, FILES_NOT_CONNECTED_REASON, TASKS_NOT_PROVEN_REASON } from '../lib/context/customer-sources'

const OUT_DIR = path.resolve(__dirname, '../../../.checkpoint-out')
const raw = JSON.parse(readFileSync(path.resolve(__dirname, './c360-checkpoint-data.json'), 'utf8'))
const detailRaw = JSON.parse(readFileSync(path.resolve(__dirname, './record-detail-data.json'), 'utf8'))
const quietRaw = JSON.parse(readFileSync(path.resolve(__dirname, './quiet-and-dayone-data.json'), 'utf8'))

const ORDER_STATE_LABEL: Record<string, string> = { draft: 'Quotation', sent: 'Quotation sent', sale: 'Confirmed', done: 'Delivered', cancel: 'Cancelled' }
const PAYMENT_STATE_LABEL: Record<string, string> = { not_paid: 'Open', in_payment: 'In payment', paid: 'Paid', partial: 'Partially paid', reversed: 'Reversed' }

const CSS_CLASS_NAMES = [
  'root', 'identityBar', 'identityLeft', 'avatar', 'identityBarTitle', 'identityBarMeta',
  'identityRight', 'identityRightButtons', 'primaryButton', 'secondaryButton', 'incompleteBanner', 'tabRow', 'tab',
  'tabActive', 'tabCount', 'body', 'tabPanel', 'tabPanelActive', 'card', 'cardHeader',
  'cardTitle', 'mutedText', 'mutedTextSmall', 'provenanceText', 'bigNumber', 'gapNotice',
  'gapHeadline', 'overviewGrid', 'overviewColumn', 'nextBestAction', 'nbaLabel', 'nbaText',
  'owedCard', 'owedAmount', 'owedMeta', 'statRows', 'statRow', 'listRows', 'listRow',
  'listRowMain', 'listRowTitle', 'listRowTitleButton', 'listRowMeta', 'statusPill',
  'sheet', 'sheetBreadcrumb', 'sheetHeader', 'sheetTitle', 'sheetHeaderActions',
  'stageTracker', 'stageTrackerCancelled', 'stageDone', 'stageCurrent', 'stageUpcoming', 'stageMarker',
  'sheetSubTabRow', 'sheetSubTab', 'sheetSubTabActive', 'sheetBody', 'sheetFieldGrid', 'sheetField',
  'lineTable', 'sheetActions', 'secondaryLink',
  'urgentCard', 'urgentCardLabel', 'urgentCardText', 'urgentCardOwed', 'urgentCardAtRisk',
  'urgentCardAction', 'urgentCardOpportunity', 'urgentCardDayOne',
]

function inlinedCss(): string {
  const rawCss = readFileSync(path.resolve(__dirname, '../components/customer/workspace-view.module.css'), 'utf8')
  let out = rawCss
  for (const key of CSS_CLASS_NAMES) {
    const resolved = (styles as Record<string, string>)[key]
    if (!resolved) {
      console.warn('CSS_CLASS_NOT_RESOLVED', key)
      continue
    }
    out = out.replace(new RegExp(`\\.${key}\\b`, 'g'), `.${resolved}`)
  }
  return out
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const nameOf = (v: unknown): string | null => (Array.isArray(v) && typeof v[1] === 'string' ? v[1] : null)

function contentEnvelope(name: ContextSectionName, records: unknown[]): ContextSectionEnvelope {
  return {
    name,
    state: records.length > 0 ? 'available' : 'empty',
    count: records.length,
    reason: null,
    provenance: { source: `odoo:${name}`, fetchedAt: '2026-09-04T00:00:00.000Z', stale: false },
    missing: [],
    records,
  }
}

function gapEnvelope(name: ContextSectionName, reason: string): ContextSectionEnvelope {
  return { name, state: 'unavailable', count: 0, reason, provenance: null, missing: [], records: [] }
}

function mapOrder(r: any) {
  const rawState = strOrNull(r.state)
  return {
    id: r.id,
    name: strOrNull(r.name),
    state: rawState,
    stateLabel: rawState ? (ORDER_STATE_LABEL[rawState] ?? rawState) : null,
    amountTotal: typeof r.amount_total === 'number' ? r.amount_total : null,
    orderedAt: strOrNull(r.date_order),
    deliveryDate: strOrNull(r.commitment_date),
    invoiceStatus: strOrNull(r.invoice_status),
    link: `https://epic-communications-inc.odoo.com/odoo/sale.order/${r.id}`,
  }
}

function mapInvoice(r: any) {
  return {
    id: r.id,
    name: strOrNull(r.name),
    state: strOrNull(r.state),
    paymentState: r.payment_state ? (PAYMENT_STATE_LABEL[r.payment_state] ?? r.payment_state) : null,
    amountTotal: typeof r.amount_total === 'number' ? r.amount_total : null,
    amountResidual: typeof r.amount_residual === 'number' ? r.amount_residual : null,
    invoiceDate: strOrNull(r.invoice_date),
    dueDate: strOrNull(r.invoice_date_due),
    link: `https://epic-communications-inc.odoo.com/odoo/account.move/${r.id}`,
  }
}

function buildContext(customerId: number, fetched: any): CustomerContextResponse {
  const p = fetched.partner[0]
  const customerRecord = {
    id: p.id,
    name: strOrNull(p.name),
    email: strOrNull(p.email),
    phone: strOrNull(p.phone),
    city: strOrNull(p.city),
    street: strOrNull(p.street),
    isCompany: p.is_company === true,
    companyName: nameOf(p.parent_id),
    active: p.active !== false,
    customerSince: strOrNull(p.create_date),
  }

  const orders = (fetched.orders as any[]).map(mapOrder)
  const invoices = (fetched.invoices as any[]).map(mapInvoice)

  const opportunities = (Array.isArray(fetched.opportunities) ? fetched.opportunities : []).map((r: any) => ({
    id: r.id,
    name: strOrNull(r.name),
    kind: strOrNull(r.type),
    stage: nameOf(r.stage_id),
    owner: nameOf(r.user_id),
    expectedRevenue: typeof r.expected_revenue === 'number' ? r.expected_revenue : null,
    deadline: strOrNull(r.date_deadline),
    updatedAt: strOrNull(r.write_date),
    link: `https://epic-communications-inc.odoo.com/odoo/crm.lead/${r.id}`,
  }))

  const issues = (Array.isArray(fetched.issues) ? fetched.issues : []).map((r: any) => ({
    id: r.id,
    name: strOrNull(r.name),
    stage: nameOf(r.stage_id),
    priority: strOrNull(r.priority),
    owner: nameOf(r.user_id),
    openedAt: strOrNull(r.create_date),
    updatedAt: strOrNull(r.write_date),
    link: `https://epic-communications-inc.odoo.com/odoo/helpdesk.ticket/${r.id}`,
  }))

  const sections = {
    customer: contentEnvelope('customer', [customerRecord]),
    contacts: gapEnvelope('contacts', 'not fetched by this checkpoint script'),
    opportunities: contentEnvelope('opportunities', opportunities),
    issues: contentEnvelope('issues', issues),
    tasks: gapEnvelope('tasks', TASKS_NOT_PROVEN_REASON),
    recentActions: gapEnvelope('recentActions', 'not fetched by this checkpoint script'),
    activity: gapEnvelope('activity', 'not fetched by this checkpoint script'),
    services: gapEnvelope('services', 'services is not connected: no authoritative source is configured'),
    devices: gapEnvelope('devices', 'devices is not connected: no authoritative source is configured'),
    pbx: gapEnvelope('pbx', 'pbx is not connected: no authoritative source is configured'),
    orders: contentEnvelope('orders', orders),
    invoices: contentEnvelope('invoices', invoices),
    calls: gapEnvelope('calls', CALLS_NOT_CONNECTED_REASON),
    files: gapEnvelope('files', FILES_NOT_CONNECTED_REASON),
    notes: gapEnvelope('notes', 'notes is not connected: no authoritative source is configured'),
  } as CustomerContextResponse['sections']

  return {
    version: 'customer-context@1',
    correlationId: `checkpoint-${customerId}`,
    customerId: String(customerId),
    role: 'manager',
    sections,
    personalLine: {
      fetchedAt: new Date().toISOString(),
      data: { state: 'not-connected', reason: 'not fetched by this checkpoint script' },
    },
    availableActions: [],
    provenance: {
      generatedAt: new Date().toISOString(),
      degraded: ['calls', 'files'] as ContextSectionName[],
      forbiddenCount: 0,
      sectionCount: 15,
    },
  }
}

function mapLines(rawLines: any[]): RecordLineItem[] {
  return rawLines.map((l) => ({
    id: l.id,
    name: strOrNull(l.name),
    quantity: typeof l.quantity === 'number' ? l.quantity : typeof l.product_uom_qty === 'number' ? l.product_uom_qty : null,
    unitPrice: typeof l.price_unit === 'number' ? l.price_unit : null,
    subtotal: typeof l.price_subtotal === 'number' ? l.price_subtotal : null,
  }))
}

const NO_RESOLUTION: ConversationResolutionView = { status: 'idle', chatwootDeepLink: null, chatwootConversationId: null }

function renderPage(
  label: string,
  context: CustomerContextResponse,
  opts: {
    selectedTab: 'overview' | 'orders' | 'invoices' | 'tickets'
    selectedRecord?: { tab: 'orders' | 'invoices' | 'tickets'; id: number } | null
    lines?: RecordLineItem[] | null
    messageComposerOpen?: boolean
    messageDraftText?: string
    conversationResolution?: ConversationResolutionView
    expandedInvoiceBuckets?: readonly string[]
    narrowWidth?: boolean
  },
) {
  const html = renderToStaticMarkup(
    <CustomerWorkspaceView
      customerId={String(context.customerId)}
      status="ready"
      context={context}
      selectedTab={opts.selectedTab}
      selectedAction={null}
      actionValues={{}}
      actionOutcome={null}
      actionPending={false}
      selectedRecord={opts.selectedRecord ?? null}
      selectedRecordSubTab="Overview"
      recordLines={opts.lines ?? null}
      recordLinesStatus={opts.lines ? 'available' : 'idle'}
      onSelectTab={() => {}}
      onSelectAction={() => {}}
      onChangeField={() => {}}
      onRun={() => {}}
      onRetryContext={() => {}}
      onSelectRecord={() => {}}
      onBackFromRecord={() => {}}
      onSelectRecordSubTab={() => {}}
      messageComposerOpen={opts.messageComposerOpen ?? false}
      messageDraftText={opts.messageDraftText ?? ''}
      conversationResolution={opts.conversationResolution ?? NO_RESOLUTION}
      onOpenMessageComposer={() => {}}
      onCloseMessageComposer={() => {}}
      onChangeMessageDraft={() => {}}
      expandedInvoiceBuckets={opts.expandedInvoiceBuckets ?? []}
      onToggleInvoiceBucket={() => {}}
    />,
  )

  const bodyContent = opts.narrowWidth
    ? `<div style="max-width:380px;border:1px dashed #999;margin:0 auto;">${html}</div>`
    : html

  const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Checkpoint — ${label}</title>
<style>
  body { margin: 0; padding: 2rem; background: #e9e6ee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  ${inlinedCss()}
</style>
</head>
<body>
${bodyContent}
</body>
</html>`

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `${label}.html`)
  writeFileSync(outPath, page, 'utf8')
  return outPath
}

describe('checkpoint render — Steps A-D', () => {
  const yvonneContext = buildContext(163, raw['yvonne-armour'])
  const yvonneOrderLines = mapLines(detailRaw.yvonneOrderLines)

  const ntrcFetched = {
    partner: detailRaw.ntrcPartner,
    orders: detailRaw.ntrcOrders,
    invoices: detailRaw.ntrcInvoices,
    opportunities: detailRaw.ntrcOpportunities,
    issues: detailRaw.ntrcIssues,
  }
  const ntrcContext = buildContext(835, ntrcFetched)
  const ntrcInvoiceLines = mapLines(detailRaw.ntrcInvoiceLines)

  const gregoryContext = buildContext(2898, quietRaw.gregoryRoyer)
  const dayOneContext = buildContext(2945, quietRaw.dayOneSignup)

  it('Step A — order sheet (Yvonne) and invoice sheet (NTRC), real Odoo data', () => {
    const pOrder = renderPage('yvonne-order-sheet', yvonneContext, {
      selectedTab: 'orders',
      selectedRecord: { tab: 'orders', id: 607 },
      lines: yvonneOrderLines,
    })
    const pInvoice = renderPage('ntrc-invoice-sheet', ntrcContext, {
      selectedTab: 'invoices',
      selectedRecord: { tab: 'invoices', id: 414 },
      lines: ntrcInvoiceLines,
    })
    console.log('WROTE', pOrder, pInvoice)
    expect(pOrder).toBeTruthy()
    expect(pInvoice).toBeTruthy()
  })

  it('Step B — the message composer, compose state on a real customer (Yvonne)', () => {
    // conversationResolution is 'not_found' here because this checkpoint has
    // no live database connection (same constraint as the Odoo fetches —
    // see this file's header). 'not_found' is not a claim that no
    // conversation exists; it is the honest default absent a live query,
    // and it is a real, correctly-handled state the resolver returns for
    // any customer who genuinely has no mirrored conversation yet.
    const draft = "Hi Patricia, about your order S00670 (EC$4,272.60 · Quotation): "
    const p = renderPage('yvonne-message-composer', yvonneContext, {
      selectedTab: 'orders',
      selectedRecord: { tab: 'orders', id: 607 },
      lines: yvonneOrderLines,
      messageComposerOpen: true,
      messageDraftText: draft,
      conversationResolution: { status: 'not_found', chatwootDeepLink: null, chatwootConversationId: null },
    })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })

  it('Step C — the urgent card: fires (NTRC, owed) and correctly does not (Gregory Royer, quiet)', () => {
    const pFires = renderPage('urgent-card-fires', ntrcContext, { selectedTab: 'overview' })
    const pQuiet = renderPage('urgent-card-quiet', gregoryContext, { selectedTab: 'overview' })
    console.log('WROTE', pFires, pQuiet)
    expect(pFires).toBeTruthy()
    expect(pQuiet).toBeTruthy()
  })

  it('Step D — day-one customer: leads with what they have, not an empty grid', () => {
    const p = renderPage('day-one-customer', dayOneContext, { selectedTab: 'overview' })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })

  it('Step D — aging buckets, SYNTHETIC data (no real fixture customer has enough invoices)', () => {
    // Real invoice shapes, made-up numbers — every amount/date below is
    // fabricated for this screenshot only, clearly so: names read
    // "SYNTH-*". NTRC's own 3 real invoices are shown correctly in the
    // Step A/C screenshots; this fixture exists purely to prove the
    // bucketing and collapse-with-expand mechanism, which no real customer
    // in this Odoo instance currently has enough rows to exercise.
    const synthInvoices = [
      { id: 9001, name: 'SYNTH-CURRENT-1', state: 'posted', payment_state: 'not_paid', amount_total: 500, amount_residual: 500, invoice_date: '2026-09-01', invoice_date_due: '2026-09-20' },
      { id: 9002, name: 'SYNTH-1-30-A', state: 'posted', payment_state: 'partial', amount_total: 1200, amount_residual: 800, invoice_date: '2026-08-20', invoice_date_due: '2026-08-25' },
      { id: 9003, name: 'SYNTH-1-30-B', state: 'posted', payment_state: 'not_paid', amount_total: 300, amount_residual: 300, invoice_date: '2026-08-18', invoice_date_due: '2026-08-22' },
      { id: 9004, name: 'SYNTH-1-30-C', state: 'posted', payment_state: 'not_paid', amount_total: 150, amount_residual: 150, invoice_date: '2026-08-15', invoice_date_due: '2026-08-20' },
      { id: 9005, name: 'SYNTH-1-30-D', state: 'posted', payment_state: 'not_paid', amount_total: 275, amount_residual: 275, invoice_date: '2026-08-10', invoice_date_due: '2026-08-18' },
      { id: 9006, name: 'SYNTH-31-60', state: 'posted', payment_state: 'not_paid', amount_total: 900, amount_residual: 900, invoice_date: '2026-07-15', invoice_date_due: '2026-07-20' },
      { id: 9007, name: 'SYNTH-60-PLUS', state: 'posted', payment_state: 'not_paid', amount_total: 2000, amount_residual: 2000, invoice_date: '2026-06-01', invoice_date_due: '2026-06-10' },
      { id: 9008, name: 'SYNTH-PAID', state: 'posted', payment_state: 'paid', amount_total: 400, amount_residual: 0, invoice_date: '2026-05-01', invoice_date_due: '2026-05-10' },
    ]
    const synthFetched = { ...ntrcFetched, invoices: synthInvoices }
    const synthContext = buildContext(835, synthFetched)
    const p = renderPage('invoice-aging-buckets', synthContext, { selectedTab: 'invoices' })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })

  it('Step D — degraded states, SYNTHETIC (an outage and a stale copy, not a real incident)', () => {
    const degraded: CustomerContextResponse = {
      ...ntrcContext,
      sections: {
        ...ntrcContext.sections,
        orders: { name: 'orders', state: 'unavailable', count: 0, reason: 'Odoo did not answer within 10s (synthetic, for this screenshot only)', provenance: null, missing: [], records: [] },
        invoices: {
          name: 'invoices',
          state: 'stale',
          count: ntrcContext.sections.invoices.records.length,
          reason: null,
          provenance: { source: 'odoo:invoices (stored copy)', fetchedAt: '2026-09-01T00:00:00.000Z', stale: true },
          missing: [],
          records: ntrcContext.sections.invoices.records,
        },
      },
    }
    const p = renderPage('degraded-states', degraded, { selectedTab: 'orders' })
    const pStale = renderPage('degraded-states-stale-invoices', degraded, { selectedTab: 'invoices' })
    console.log('WROTE', p, pStale)
    expect(p).toBeTruthy()
    expect(pStale).toBeTruthy()
  })

  it('Step D — narrow width, the Chatwoot dashboard-app sidebar panel size (~380px)', () => {
    const p = renderPage('narrow-width', yvonneContext, { selectedTab: 'overview', narrowWidth: true })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })
})
