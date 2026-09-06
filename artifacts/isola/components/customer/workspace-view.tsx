/**
 * The Customer 360 workspace, as a PURE FUNCTION of its props.
 *
 * No fetching, no hooks, no router. That is what makes it testable with
 * renderToStaticMarkup in a workspace with no jsdom — the same arrangement
 * `components/activity/recent-work-view.tsx` uses, and for the same reason.
 * The record-detail sheet added in this pass (Step A of the owner's
 * 2026-09-04 build order) keeps this rule: which record is open and which
 * of its sub-tabs is selected are both controller state, passed down as
 * props, never held here.
 *
 * DESIGN AUTHORITY: design/CUSTOMER-360-DESIGN-STUDY.md, written 2026-09-04
 * against `Lumen Unified Workspace (standalone)1a.html` and its own source
 * (`design_handoff_isola/customer.jsx`). Two owner rulings this pass
 * implements directly:
 *   - list rows open an IN-APP detail sheet (never an external link as the
 *     primary action — "Open in Odoo" stays as a secondary escape hatch);
 *   - the sheet's stage tracker is COMPUTED from real Odoo state, never a
 *     fixed position (the reference's own source hardcodes it for two of
 *     three kinds — a mock's placeholder plumbing, not a defect to copy).
 *
 * THE RULES THIS FILE IS STILL ACCOUNTABLE FOR (unchanged by this pass)
 * --------------------------------------------------------------------
 * 1. NO BLANK CARD IS A STATE. 2. FORBIDDEN DISCLOSES NOTHING.
 * 3. STATUS IS NEVER COLOUR ALONE. 4. NOTHING IS INVENTED — a panel with no
 *    data source yet renders a NAMED GAP, never fabricated content, never
 *    deleted. 5. A WRITE IS DESCRIBED BEFORE IT HAPPENS — this pass adds no
 *    new writes; every domain action in a detail sheet (Convert to invoice,
 *    Re-register extension, etc.) renders informational/disabled until a
 *    governed write path exists for it, exactly like AI insights/Calls/
 *    Files stay honest gap cards until their sources exist.
 * 6. RETRY ADVICE IS PER STATE, NOT PER FLAG.
 */

import type {
  ContextSectionEnvelope,
  ContextSectionName,
  CustomerContextResponse,
  AvailableAction,
} from '@/lib/context/customer-context'
import type { ActionField } from '@/lib/governed/executors/catalogue'
import {
  LIFECYCLE_PRESENTATION,
  mayHaveWritten,
  type ActionLifecycleState,
  type SectionState,
} from '@/lib/customer-workspace/contract'
import {
  ORDER_STAGES,
  INVOICE_STAGES,
  TICKET_STAGES,
  orderStageIndex,
  invoiceStageIndex,
  ticketStageIndex,
} from '@/lib/customer-workspace/record-stage'
import styles from './workspace-view.module.css'

/* ── the outcome as the actions route sends it ─────────────────────────────*/

export interface ActionOutcomeView {
  actionType: string
  lifecycle: ActionLifecycleState
  success: boolean
  label: string
  detail: string
  marker: string
  tone: string
  terminal: boolean
  retryWrite: string
  retryReadback: string
  escalate: boolean
  showsPriorResult: boolean
  operationId: string | null
  auditRef: string | null
  readbackProven: boolean
  approvalRef: string | null
}

export type WorkspaceTabName =
  | 'overview'
  | 'timeline'
  | 'deals'
  | 'orders'
  | 'invoices'
  | 'tickets'
  | 'calls'
  | 'files'

export const TAB_LABEL: Readonly<Record<WorkspaceTabName, string>> = {
  overview: 'Overview',
  timeline: 'Timeline',
  deals: 'Deals',
  orders: 'Orders',
  invoices: 'Invoices',
  tickets: 'Tickets',
  calls: 'Calls',
  files: 'Files',
}

export const TAB_ORDER: readonly WorkspaceTabName[] = [
  'overview',
  'timeline',
  'deals',
  'orders',
  'invoices',
  'tickets',
  'calls',
  'files',
]

export const TAB_SECTION: Readonly<Partial<Record<WorkspaceTabName, ContextSectionName>>> = {
  deals: 'opportunities',
  orders: 'orders',
  invoices: 'invoices',
  tickets: 'issues',
  calls: 'calls',
  files: 'files',
}

/** Which tabs open an in-app detail sheet on their rows. Deals (crm.lead) is
 *  deliberately excluded this pass — the reference has no distinct "deal"
 *  sheet spec (it conflates Deals with Orders; see the design study §1/§4),
 *  and inventing one without a validated spec would be exactly the kind of
 *  guess this whole exercise exists to avoid. Deals stays list-only until a
 *  real spec exists. */
const DRILLABLE_TABS: readonly WorkspaceTabName[] = ['orders', 'invoices', 'tickets']

export type DetailKind = 'order' | 'invoice' | 'ticket'

export function detailKindFor(tab: WorkspaceTabName): DetailKind | null {
  if (tab === 'orders') return 'order'
  if (tab === 'invoices') return 'invoice'
  if (tab === 'tickets') return 'ticket'
  return null
}

export interface SelectedRecord {
  tab: WorkspaceTabName
  id: number
}

/** The one place both the view and the controller look up "which record is
 *  this" — so the controller can build Step B's draft text without
 *  reimplementing the section/tab lookup `openSheetFor` already does. */
export function findSelectedRecord(
  context: CustomerContextResponse,
  selected: SelectedRecord | null,
): Record<string, unknown> | null {
  if (!selected) return null
  const sectionName = TAB_SECTION[selected.tab]
  if (!sectionName) return null
  const records = context.sections[sectionName].records as Record<string, unknown>[]
  return records.find((r) => r.id === selected.id) ?? null
}

/** Same fallback the identity bar itself uses ('This customer' when the
 *  customer section hasn't answered) — shared so a message drafted before
 *  the header repaints doesn't disagree with what the header shows. */
export function customerLabelFor(context: CustomerContextResponse): string {
  const customerRecord = (context.sections.customer.records[0] ?? null) as Record<string, unknown> | null
  return customerRecord ? recordTitle(customerRecord) : 'This customer'
}

export interface RecordLineItem {
  id: number
  name: string | null
  quantity: number | null
  unitPrice: number | null
  subtotal: number | null
}

export type RecordLinesStatus = 'idle' | 'loading' | 'available' | 'unavailable'

/** Step B: resolving this customer's Chatwoot conversation by phone.
 *  'not_found' is a normal answer (no mirror row yet), never an error. */
export type ConversationResolutionStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error'

export interface ConversationResolutionView {
  status: ConversationResolutionStatus
  chatwootDeepLink: string | null
  chatwootConversationId: number | null
}

export interface WorkspaceViewProps {
  customerId: string
  status: 'loading' | 'ready' | 'not_found' | 'forbidden' | 'error'
  context: CustomerContextResponse | null
  errorDetail?: string | null
  selectedTab: WorkspaceTabName
  selectedAction: string | null
  actionValues: Record<string, string>
  actionOutcome: ActionOutcomeView | null
  actionPending: boolean
  /** Step A: which record's in-app detail sheet is open, if any. */
  selectedRecord: SelectedRecord | null
  /** Which sub-tab within the open sheet ('overview' | kind-specific second/third). */
  selectedRecordSubTab: string
  /** Line items for an order/invoice sheet's second sub-tab. Null for a ticket (no lines), or before/while fetched. */
  recordLines: readonly RecordLineItem[] | null
  recordLinesStatus: RecordLinesStatus
  onSelectTab: (tab: WorkspaceTabName) => void
  onSelectAction: (actionType: string | null) => void
  onChangeField: (name: string, value: string) => void
  onRun: () => void
  onRetryContext: () => void
  onSelectRecord: (tab: WorkspaceTabName, id: number) => void
  onBackFromRecord: () => void
  onSelectRecordSubTab: (subTab: string) => void
  /** Step B: the message composer. Open state, draft text and phone
   *  resolution are all controller state, passed down — same rule this
   *  file already applies to the record sheet (see file header). */
  messageComposerOpen: boolean
  messageDraftText: string
  conversationResolution: ConversationResolutionView
  onOpenMessageComposer: () => void
  onCloseMessageComposer: () => void
  onChangeMessageDraft: (text: string) => void
  /** Step D: which aging buckets on the Invoices tab are expanded past
   *  their first few rows. Controller state, same rule as everything else
   *  interactive in this file. */
  expandedInvoiceBuckets: readonly string[]
  onToggleInvoiceBucket: (bucket: string) => void
}

/* ── labels ────────────────────────────────────────────────────────────────*/

const SECTION_LABEL: Readonly<Record<ContextSectionName, string>> = {
  customer: 'Customer',
  contacts: 'Contacts',
  opportunities: 'Deals',
  issues: 'Support tickets',
  tasks: 'Follow-ups',
  recentActions: 'Recent governed actions',
  activity: 'Activity',
  services: 'Services',
  devices: 'Devices',
  pbx: 'PBX',
  orders: 'Orders',
  invoices: 'Invoices',
  calls: 'Recent calls',
  files: 'Files & documents',
  notes: 'Notes',
}

const GAP_WHAT_IT_NEEDS: Readonly<Partial<Record<ContextSectionName, string>>> = {
  tasks:
    'A proven customer relationship on project.task (currently keyed only by assignee, never by partner) — one ir.model.fields read settles which field to use.',
  calls:
    "A server-to-server read of bff-v2's Magnus CDR data (getMagnusUserCallsEnriched already exists there) and this partner's magnusUserId, when one exists (Personal Line accounts only).",
  files:
    'An ir.attachment reader scoped to res_model=res.partner and res_id=this customer, same shape as every other reader in this file.',
}

const SECTION_STATE_TEXT: Readonly<Record<SectionState, { marker: string; label: string }>> = {
  loading: { marker: '…', label: 'Loading' },
  available: { marker: '•', label: 'Showing' },
  empty: { marker: '–', label: 'Nothing recorded' },
  partial: { marker: '⚠', label: 'Incomplete' },
  stale: { marker: '⌛', label: 'Stored copy' },
  forbidden: { marker: '🔒', label: 'Not available to you' },
  unavailable: { marker: '⟳', label: 'Could not be read' },
  error: { marker: '!', label: 'Could not be understood' },
  retrying: { marker: '↻', label: 'Retrying' },
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function money(n: number | null): string {
  if (n === null) return '—'
  return `EC$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function recordTitle(record: Record<string, unknown>): string {
  return (
    str(record.name) ??
    str(record.title) ??
    str(record.actionType) ??
    str(record.summary) ??
    (typeof record.id === 'number' ? `#${record.id}` : 'Record')
  )
}

/** The customer-facing status word for a row/header. `paymentState`
 *  (invoices: Open/Paid/Partially paid) and `stateLabel` (orders:
 *  Quotation/Confirmed/Delivered/Cancelled) are the friendly labels;
 *  `stage` (tickets) already is one; raw `state` is the last resort and
 *  should rarely be reached — it exists on the record only for
 *  record-stage.ts's real stage computation, never meant for display. */
function recordStatus(record: Record<string, unknown>): string | null {
  return str(record.paymentState) ?? str(record.stateLabel) ?? str(record.stage) ?? str(record.state) ?? null
}

function recordAmount(record: Record<string, unknown>): number | null {
  return num(record.amountTotal) ?? num(record.expectedRevenue) ?? null
}

function recordDate(record: Record<string, unknown>): string | null {
  return (
    str(record.orderedAt) ??
    str(record.invoiceDate) ??
    str(record.updatedAt) ??
    str(record.openedAt) ??
    str(record.deadline) ??
    null
  )
}

/* ── stage tracker (real, computed — see lib/customer-workspace/record-stage.ts) ── */

function StageTracker({ stages, currentIndex }: { stages: readonly string[]; currentIndex: number | null }) {
  if (currentIndex === null) {
    return (
      <div className={styles.stageTrackerCancelled} data-stage-unresolved="true">
        Stage could not be placed on this tracker from its current Odoo state — shown as text, not guessed
        visually.
      </div>
    )
  }
  return (
    <div className={styles.stageTracker} role="list" aria-label="Stage">
      {stages.map((label, i) => (
        <div
          key={label}
          role="listitem"
          className={i < currentIndex ? styles.stageDone : i === currentIndex ? styles.stageCurrent : styles.stageUpcoming}
          data-stage={label}
          data-stage-state={i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming'}
        >
          <span className={styles.stageMarker} aria-hidden="true">
            {i < currentIndex ? '✓' : i + 1}
          </span>
          {label}
        </div>
      ))}
    </div>
  )
}

/* ── the message composer (Step B) ─────────────────────────────────────────
 *
 * One composer, shared by the identity bar's "Message" button and every
 * sheet's "Message" button — the reference's quickMessage(ct.id, text) is
 * called from every record kind with record-specific pre-filled text
 * ("About invoice X:", "About order X:"), never a separate widget per kind.
 * Sending is NOT wired this pass: real customer contact is an owner-only
 * action (CLAUDE.md §6), so Send stays disabled/informational — the same
 * "governed action, described before it happens" discipline the sheet's own
 * domain-action buttons already use. */

/** Pure — same record-title/status/amount helpers the sheet uses, so the
 *  draft text never disagrees with what's on screen. */
export function draftMessageFor(
  customerLabel: string,
  kind: DetailKind | null,
  record: Record<string, unknown> | null,
): string {
  const firstName = customerLabel.split(' ')[0] || customerLabel
  if (!kind || !record) return `Hi ${firstName}, `
  const title = recordTitle(record)
  const detail = [
    (() => {
      const a = recordAmount(record)
      return a !== null ? money(a) : null
    })(),
    recordStatus(record),
  ]
    .filter(Boolean)
    .join(' · ')
  const noun = kind === 'order' ? 'order' : kind === 'invoice' ? 'invoice' : 'ticket'
  return `Hi ${firstName}, about your ${noun} ${title}${detail ? ` (${detail})` : ''}: `
}

function MessageComposer({
  draftText,
  resolution,
  onChangeDraft,
  onClose,
}: {
  draftText: string
  resolution: ConversationResolutionView
  onChangeDraft: (text: string) => void
  onClose: () => void
}) {
  return (
    <section aria-labelledby="message-composer-title" className={styles.card} data-message-composer="true">
      <div className={styles.sheetHeader}>
        <h3 id="message-composer-title" className={styles.cardTitle}>
          Message this customer
        </h3>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>
          Close
        </button>
      </div>

      {resolution.status === 'loading' ? (
        <p className={styles.mutedText} data-conversation-status="loading">
          Resolving this customer&rsquo;s Chatwoot conversation by phone…
        </p>
      ) : resolution.status === 'found' && resolution.chatwootDeepLink === null ? (
        // Step E: a real conversation was found, but its inbox has no
        // ChatwootBinding row — the same "inbox not linked" gap that made
        // conv #40 unreachable from here. This is an honest surface, not a
        // silent dead end: it says exactly what is missing rather than
        // implying a working link that doesn't exist.
        <p className={styles.mutedTextSmall} data-conversation-status="found-unlinked">
          Resolved to an existing Chatwoot conversation
          {resolution.chatwootConversationId !== null ? ` (#${resolution.chatwootConversationId})` : ''}, but its
          inbox isn&rsquo;t linked to this workspace yet — no direct link is available until that binding is added.
        </p>
      ) : resolution.status === 'found' ? (
        <p className={styles.mutedTextSmall} data-conversation-status="found">
          Resolved to an existing Chatwoot conversation
          {resolution.chatwootConversationId !== null ? ` (#${resolution.chatwootConversationId})` : ''} by this
          customer&rsquo;s phone number.
        </p>
      ) : resolution.status === 'not_found' ? (
        <p className={styles.mutedTextSmall} data-conversation-status="not_found">
          No Chatwoot conversation found yet for this customer&rsquo;s phone number — a real, possibly brand-new
          customer, not a lookup failure.
        </p>
      ) : resolution.status === 'error' ? (
        <p className={styles.mutedTextSmall} data-conversation-status="error">
          The Chatwoot conversation could not be resolved right now. This is an outage, not a verdict on whether one
          exists.
        </p>
      ) : null}

      <textarea
        className="mt-2 min-h-24 w-full rounded-md border px-3 py-2 text-sm"
        value={draftText}
        onChange={(e) => onChangeDraft(e.target.value)}
        rows={4}
        aria-label="Message to customer"
      />

      <div className={styles.sheetActions}>
        <button type="button" className={styles.primaryButton} disabled title="Governed send path not built yet">
          Send
        </button>
        {resolution.chatwootDeepLink ? (
          <a href={resolution.chatwootDeepLink} target="_blank" rel="noreferrer noopener" className={styles.secondaryLink}>
            Open in Chatwoot ↗
          </a>
        ) : null}
      </div>
      <p className={styles.mutedText}>
        Nothing is sent from here yet — this previews exactly what would go to the customer once a governed send
        path exists.
      </p>
    </section>
  )
}

/* ── the record detail sheet ─────────────────────────────────────────────── */

const SHEET_SUBTABS: Readonly<Record<DetailKind, readonly string[]>> = {
  order: ['Overview', 'Line items', 'Fulfilment'],
  invoice: ['Overview', 'Lines', 'Payments'],
  ticket: ['Overview', 'Diagnosis', 'Resolution'],
}

const SHEET_STAGES: Readonly<Record<DetailKind, readonly string[]>> = {
  order: ORDER_STAGES,
  invoice: INVOICE_STAGES,
  ticket: TICKET_STAGES,
}

function LineItemsTable({ lines, status }: { lines: readonly RecordLineItem[] | null; status: RecordLinesStatus }) {
  if (status === 'loading') return <p className={styles.mutedText}>Loading line items…</p>
  if (status === 'unavailable') {
    return (
      <div className={styles.gapNotice} data-gap="record-lines">
        <p className={styles.gapHeadline}>Line items — not connected.</p>
        <p className={styles.mutedText}>The line-item read did not answer. Nothing about this record has changed.</p>
      </div>
    )
  }
  if (!lines || lines.length === 0) {
    return <p className={styles.mutedText}>No line items recorded.</p>
  }
  return (
    <table className={styles.lineTable}>
      <thead>
        <tr>
          <th>Item</th>
          <th>Qty</th>
          <th>Unit price</th>
          <th>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td>{l.name ?? '—'}</td>
            <td>{l.quantity ?? '—'}</td>
            <td>{money(l.unitPrice)}</td>
            <td>{money(l.subtotal)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function NotYetBuiltSubTab({ what, needs }: { what: string; needs: string }) {
  return (
    <div className={styles.gapNotice} data-gap={what}>
      <p className={styles.gapHeadline}>{what} — not connected.</p>
      <p className={styles.mutedText}>
        <strong>What would close this: </strong>
        {needs}
      </p>
    </div>
  )
}

function RecordDetailSheet({
  customerLabel,
  kind,
  record,
  subTab,
  lines,
  linesStatus,
  odooLink,
  onBack,
  onSelectSubTab,
  onOpenMessageComposer,
}: {
  customerLabel: string
  kind: DetailKind
  record: Record<string, unknown>
  subTab: string
  lines: readonly RecordLineItem[] | null
  linesStatus: RecordLinesStatus
  odooLink: string | null
  onBack: () => void
  onSelectSubTab: (subTab: string) => void
  onOpenMessageComposer: () => void
}) {
  const title = recordTitle(record)
  const status = recordStatus(record)
  const amount = recordAmount(record)
  const subTabs = SHEET_SUBTABS[kind]
  const activeSubTab = subTabs.includes(subTab) ? subTab : subTabs[0]

  const stageIndex =
    kind === 'order'
      ? orderStageIndex({ state: str(record.state)?.toLowerCase() ?? null, invoiceStatus: str(record.invoiceStatus) })
      : kind === 'invoice'
        ? invoiceStageIndex({
            state: str(record.state) ?? null,
            paymentState: str(record.paymentState),
            dueDate: str(record.dueDate),
          })
        : ticketStageIndex(str(record.stage))

  return (
    <div className={styles.sheet} data-record-sheet={kind}>
      <div className={styles.sheetBreadcrumb}>
        {customerLabel} <span aria-hidden="true">→</span> {title}
      </div>
      <div className={styles.sheetHeader}>
        <div>
          <h3 className={styles.sheetTitle}>{title}</h3>
          <p className={styles.mutedTextSmall}>
            {[amount !== null ? money(amount) : null, status].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className={styles.sheetHeaderActions}>
          <button type="button" className={styles.secondaryButton} onClick={onOpenMessageComposer}>
            Message
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onBack}>
            Back
          </button>
        </div>
      </div>

      <StageTracker stages={SHEET_STAGES[kind]} currentIndex={stageIndex} />

      <div className={styles.sheetSubTabRow} role="tablist" aria-label={`${title} sections`}>
        {subTabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={activeSubTab === t}
            className={activeSubTab === t ? `${styles.sheetSubTab} ${styles.sheetSubTabActive}` : styles.sheetSubTab}
            onClick={() => onSelectSubTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className={styles.sheetBody}>
        {activeSubTab === 'Overview' ? (
          <dl className={styles.sheetFieldGrid}>
            {kind === 'order' ? (
              <>
                <div className={styles.sheetField}><dt>Order value</dt><dd>{money(amount)}</dd></div>
                <div className={styles.sheetField}><dt>Status</dt><dd>{status ?? '—'}</dd></div>
                <div className={styles.sheetField}><dt>Ordered</dt><dd>{shortDate(str(record.orderedAt))}</dd></div>
                <div className={styles.sheetField}><dt>Delivery</dt><dd>{shortDate(str(record.deliveryDate))}</dd></div>
              </>
            ) : kind === 'invoice' ? (
              <>
                <div className={styles.sheetField}><dt>Amount</dt><dd>{money(amount)}</dd></div>
                <div className={styles.sheetField}><dt>Status</dt><dd>{status ?? '—'}</dd></div>
                <div className={styles.sheetField}><dt>Invoice date</dt><dd>{shortDate(str(record.invoiceDate))}</dd></div>
                <div className={styles.sheetField}><dt>Due</dt><dd>{shortDate(str(record.dueDate))}</dd></div>
              </>
            ) : (
              <>
                <div className={styles.sheetField}><dt>Priority</dt><dd>{str(record.priority) ?? '—'}</dd></div>
                <div className={styles.sheetField}><dt>Stage</dt><dd>{status ?? '—'}</dd></div>
                <div className={styles.sheetField}><dt>Opened</dt><dd>{shortDate(str(record.openedAt))}</dd></div>
                <div className={styles.sheetField}><dt>Owner</dt><dd>{str(record.owner) ?? 'Unassigned'}</dd></div>
              </>
            )}
          </dl>
        ) : activeSubTab === 'Line items' || activeSubTab === 'Lines' ? (
          <LineItemsTable lines={lines} status={linesStatus} />
        ) : activeSubTab === 'Fulfilment' ? (
          <NotYetBuiltSubTab
            what="Fulfilment"
            needs="A stock.picking read scoped to this order, for real delivery status beyond the invoice_status proxy the stage tracker currently uses."
          />
        ) : activeSubTab === 'Payments' ? (
          <NotYetBuiltSubTab
            what="Payments"
            needs="An account.payment read scoped to this invoice's reconciled payments."
          />
        ) : activeSubTab === 'Diagnosis' ? (
          <NotYetBuiltSubTab
            what="Diagnosis"
            needs="This ticket's own message log (mail.message on helpdesk.ticket) — the same source named for Timeline in dec-c360-ai-insights-scope-definition-2026-08-30."
          />
        ) : (
          <NotYetBuiltSubTab
            what="Resolution"
            needs="A resolution-note field or the ticket's closing message, once the message log above is read."
          />
        )}
      </div>

      <div className={styles.sheetActions}>
        <button type="button" className={styles.primaryButton} disabled title="Governed write path not built yet">
          {kind === 'order' ? 'Convert to invoice' : kind === 'invoice' ? 'Collect payment' : 'Re-register extension'}
        </button>
        {odooLink ? (
          <a href={odooLink} target="_blank" rel="noreferrer noopener" className={styles.secondaryLink}>
            Open in Odoo ↗
          </a>
        ) : null}
      </div>
    </div>
  )
}

/* ── generic list row: clicking opens the in-app sheet, never an external link ── */

function ListRow({
  record,
  tab,
  drillable,
  onSelectRecord,
}: {
  record: Record<string, unknown>
  tab: WorkspaceTabName
  drillable: boolean
  onSelectRecord: (tab: WorkspaceTabName, id: number) => void
}) {
  const status = recordStatus(record)
  const amount = recordAmount(record)
  const date = recordDate(record)
  const title = recordTitle(record)
  const id = typeof record.id === 'number' ? record.id : null

  return (
    <li className={styles.listRow} data-record-model={tab}>
      <div className={styles.listRowMain}>
        {drillable && id !== null ? (
          <button type="button" className={styles.listRowTitleButton} onClick={() => onSelectRecord(tab, id)}>
            {title}
          </button>
        ) : (
          <div className={styles.listRowTitle}>{title}</div>
        )}
        <div className={styles.listRowMeta}>
          {[date ? shortDate(date) : null, amount !== null ? money(amount) : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {status ? <span className={styles.statusPill}>{status}</span> : null}
    </li>
  )
}

function ListTab({
  section,
  tab,
  onSelectRecord,
}: {
  section: ContextSectionEnvelope
  tab: WorkspaceTabName
  onSelectRecord: (tab: WorkspaceTabName, id: number) => void
}) {
  const text = SECTION_STATE_TEXT[section.state]
  const label = SECTION_LABEL[section.name]
  const drillable = DRILLABLE_TABS.includes(tab)

  if (section.state === 'forbidden') {
    return (
      <div className={styles.card} data-section={section.name} data-state="forbidden">
        <h3 className={styles.cardTitle}>{label}</h3>
        <p className={styles.mutedText}>
          <span aria-hidden="true">{text.marker} </span>You do not have access to this section.
        </p>
      </div>
    )
  }

  const records = section.records as Record<string, unknown>[]
  const isGap = section.state === 'unavailable' && GAP_WHAT_IT_NEEDS[section.name]

  return (
    <div className={styles.card} data-section={section.name} data-state={section.state}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{label}</h3>
        <span className={styles.mutedTextSmall}>
          <span aria-hidden="true">{text.marker} </span>
          {text.label}
          {section.state === 'available' || section.state === 'partial' || section.state === 'stale'
            ? ` ${section.count}`
            : ''}
        </span>
      </div>

      {isGap ? (
        <div className={styles.gapNotice} data-gap={section.name}>
          <p className={styles.gapHeadline}>Not connected yet.</p>
          <p className={styles.mutedText}>{section.reason}</p>
          <p className={styles.mutedText}>
            <strong>What would close this: </strong>
            {GAP_WHAT_IT_NEEDS[section.name]}
          </p>
        </div>
      ) : section.reason ? (
        <p className={styles.mutedText}>{section.reason}</p>
      ) : null}

      {!isGap && section.state === 'empty' ? (
        <p className={styles.mutedText}>This was read successfully and there is nothing recorded.</p>
      ) : null}

      {section.missing.length > 0 ? (
        <p className={styles.mutedTextSmall}>Not included: {section.missing.join(', ')}</p>
      ) : null}

      {records.length > 0 ? (
        <ul className={styles.listRows}>
          {records.map((record, index) => (
            <ListRow key={index} record={record} tab={tab} drillable={drillable} onSelectRecord={onSelectRecord} />
          ))}
        </ul>
      ) : null}

      {section.provenance ? (
        <p className={styles.provenanceText}>
          From {section.provenance.source}
          {section.provenance.stale ? ' (stored copy)' : ''}
        </p>
      ) : null}
    </div>
  )
}

/* ── Invoices: aging buckets, not a flat list (Step D, ratified 2026-09-04:
 * "that matches how the business will actually read it once Odoo owns all
 * billing on 1 November") ── */

const AGING_BUCKET_ORDER = ['current', '1-30', '31-60', '60+'] as const
type AgingBucketKey = (typeof AGING_BUCKET_ORDER)[number]

const AGING_BUCKET_LABEL: Readonly<Record<AgingBucketKey, string>> = {
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '60+': '60+ days',
}

const AGING_VISIBLE_PER_BUCKET = 3

/** Not paid, or not yet due → Current. Overdue and unpaid → bucketed by
 *  days since the due date. A missing due date can't be aged, so it stays
 *  Current rather than being guessed into a bucket it may not belong in. */
export function agingBucketFor(record: Record<string, unknown>, nowMs: number): AgingBucketKey {
  const residual = num(record.amountResidual) ?? 0
  const due = str(record.dueDate)
  if (residual <= 0 || !due) return 'current'
  const dueMs = new Date(due).getTime()
  if (Number.isNaN(dueMs) || dueMs >= nowMs) return 'current'
  const daysOverdue = Math.floor((nowMs - dueMs) / 86_400_000)
  if (daysOverdue <= 30) return '1-30'
  if (daysOverdue <= 60) return '31-60'
  return '60+'
}

function InvoiceAgingTab({
  section,
  expandedBuckets,
  onToggleBucket,
  onSelectRecord,
}: {
  section: ContextSectionEnvelope
  expandedBuckets: readonly string[]
  onToggleBucket: (bucket: string) => void
  onSelectRecord: (tab: WorkspaceTabName, id: number) => void
}) {
  const text = SECTION_STATE_TEXT[section.state]
  const label = SECTION_LABEL[section.name]

  // Every non-happy-path state (forbidden/unavailable/error/retrying/loading)
  // falls back to the exact same generic rendering ListTab already uses —
  // aging is a presentation of AVAILABLE rows, not a second state machine.
  if (section.state !== 'available' && section.state !== 'partial' && section.state !== 'stale' && section.state !== 'empty') {
    return <ListTab section={section} tab="invoices" onSelectRecord={onSelectRecord} />
  }

  const records = section.records as Record<string, unknown>[]
  if (records.length === 0) {
    return (
      <div className={styles.card} data-section={section.name} data-state={section.state}>
        <h3 className={styles.cardTitle}>{label}</h3>
        <p className={styles.mutedText}>This was read successfully and there is nothing recorded.</p>
      </div>
    )
  }

  const nowMs = Date.now()
  const buckets = new Map<AgingBucketKey, Record<string, unknown>[]>(AGING_BUCKET_ORDER.map((k) => [k, []]))
  for (const r of records) buckets.get(agingBucketFor(r, nowMs))!.push(r)

  return (
    <div className={styles.card} data-section={section.name} data-state={section.state} data-invoice-aging="true">
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{label}</h3>
        <span className={styles.mutedTextSmall}>
          <span aria-hidden="true">{text.marker} </span>
          {text.label} {section.count}
        </span>
      </div>

      {AGING_BUCKET_ORDER.filter((key) => buckets.get(key)!.length > 0).map((key) => {
        const bucketRecords = [...buckets.get(key)!].sort((a, b) => {
          const da = str(a.invoiceDate)
          const db = str(b.invoiceDate)
          return (db ? new Date(db).getTime() : 0) - (da ? new Date(da).getTime() : 0)
        })
        const total = bucketRecords.reduce((sum, r) => sum + (num(r.amountResidual) ?? 0), 0)
        const expanded = expandedBuckets.includes(key)
        const visible = expanded ? bucketRecords : bucketRecords.slice(0, AGING_VISIBLE_PER_BUCKET)
        const hiddenCount = bucketRecords.length - visible.length

        return (
          <div key={key} data-aging-bucket={key} className="mt-3">
            <div className={styles.cardHeader}>
              <h4 className={styles.cardTitle}>
                {AGING_BUCKET_LABEL[key]} ({bucketRecords.length})
              </h4>
              <span className={styles.mutedTextSmall}>{money(total)}</span>
            </div>
            <ul className={styles.listRows}>
              {visible.map((record) => (
                <ListRow key={String(record.id)} record={record} tab="invoices" drillable onSelectRecord={onSelectRecord} />
              ))}
            </ul>
            {hiddenCount > 0 || (expanded && bucketRecords.length > AGING_VISIBLE_PER_BUCKET) ? (
              <button type="button" className={styles.secondaryButton} onClick={() => onToggleBucket(key)}>
                {hiddenCount > 0 ? `Show ${hiddenCount} more` : 'Show fewer'}
              </button>
            ) : null}
          </div>
        )
      })}

      {section.provenance ? (
        <p className={styles.provenanceText}>
          From {section.provenance.source}
          {section.provenance.stale ? ' (stored copy)' : ''}
        </p>
      ) : null}
    </div>
  )
}

/* ── Overview: the composite dashboard ─────────────────────────────────────*/

function nextBestAction(context: CustomerContextResponse): { text: string; targetTab: WorkspaceTabName } | null {
  const invoices = context.sections.invoices.records as Record<string, unknown>[]
  const overdue = invoices.find((r) => num(r.amountResidual) && num(r.amountResidual)! > 0)
  if (overdue) {
    return {
      text: `Collect ${money(num(overdue.amountResidual))} on ${str(overdue.name) ?? 'an open invoice'} — due ${shortDate(str(overdue.dueDate))}.`,
      targetTab: 'invoices',
    }
  }
  const orders = context.sections.orders.records as Record<string, unknown>[]
  const openOrder = orders.find((r) => str(r.state) !== 'done' && str(r.state) !== 'cancel')
  if (openOrder) {
    return { text: `Follow up on ${str(openOrder.name) ?? 'an open order'} — ${str(openOrder.stateLabel) ?? 'in progress'}.`, targetTab: 'orders' }
  }
  return null
}

/* ── the urgent card (Step C) ────────────────────────────────────────────
 *
 * One card, top right of the identity bar, visible regardless of which tab
 * is open — unlike the Overview tab's own nextBestAction banner/OwedCard,
 * which only render when Overview is selected. Checked in a fixed priority
 * order (owed money outranks a ticket, a ticket outranks a stalled order,
 * an order outranks a deal) and returns null — no card at all — the moment
 * every check comes back empty. "Never fires when nothing true to say" is
 * the whole point: a customer with nothing owed, no risky ticket, no open
 * order and no open deal gets silence here, not a fabricated reason to
 * show a card. */

export type UrgentKind = 'owed' | 'at_risk' | 'action_needed' | 'opportunity' | 'day_one'

export interface UrgentSignal {
  kind: UrgentKind
  label: string
  text: string
}

const URGENT_CARD_CLASS: Readonly<Record<UrgentKind, string>> = {
  owed: styles.urgentCardOwed,
  at_risk: styles.urgentCardAtRisk,
  action_needed: styles.urgentCardAction,
  opportunity: styles.urgentCardOpportunity,
  day_one: styles.urgentCardDayOne,
}

const URGENT_LABEL: Readonly<Record<UrgentKind, string>> = {
  owed: 'Owed',
  at_risk: 'At risk',
  action_needed: 'Action needed',
  opportunity: 'Opportunity',
  day_one: 'New customer',
}

/** True only when every commercial section actually ANSWERED (never on an
 *  outage — an unavailable section must never be misread as "day one") and
 *  all three came back with zero rows. The ratified 2026-09-04 ruling: "a
 *  Personal Line signup is not an empty customer" — this is the one test
 *  both the urgent card and the Overview layout use to decide when that
 *  ruling applies. */
export function commercialSectionsAnsweredAndEmpty(context: CustomerContextResponse): boolean {
  const sections = [context.sections.invoices, context.sections.orders, context.sections.opportunities]
  const allAnswered = sections.every(
    (s) => s.state === 'available' || s.state === 'empty' || s.state === 'partial' || s.state === 'stale',
  )
  const allEmpty = sections.every((s) => (s.records as unknown[]).length === 0)
  return allAnswered && allEmpty
}

/** Odoo helpdesk.ticket priority: '0' Low, '1' Medium, '2' High, '3' Urgent. */
const AT_RISK_PRIORITIES = new Set(['2', '3'])

export function urgentSignal(context: CustomerContextResponse): UrgentSignal | null {
  const invoiceSection = context.sections.invoices
  if (invoiceSection.state === 'available' || invoiceSection.state === 'partial' || invoiceSection.state === 'stale') {
    const invoices = invoiceSection.records as Record<string, unknown>[]
    const owed = invoices.reduce((sum, r) => sum + (num(r.amountResidual) ?? 0), 0)
    if (owed > 0) {
      const topUnpaid = invoices.find((r) => (num(r.amountResidual) ?? 0) > 0)
      const due = topUnpaid ? str(topUnpaid.dueDate) : null
      return { kind: 'owed', label: URGENT_LABEL.owed, text: `${money(owed)} owed${due ? ` — due ${shortDate(due)}` : ''}` }
    }
  }

  const issueSection = context.sections.issues
  if (issueSection.state === 'available' || issueSection.state === 'partial' || issueSection.state === 'stale') {
    const tickets = issueSection.records as Record<string, unknown>[]
    const urgentTicket = tickets.find((r) => {
      const p = r.priority
      return typeof p === 'string' && AT_RISK_PRIORITIES.has(p)
    })
    if (urgentTicket) {
      return {
        kind: 'at_risk',
        label: URGENT_LABEL.at_risk,
        text: `${str(urgentTicket.name) ?? 'A support ticket'} is high priority and still open.`,
      }
    }
  }

  const orderSection = context.sections.orders
  if (orderSection.state === 'available' || orderSection.state === 'partial' || orderSection.state === 'stale') {
    const orders = orderSection.records as Record<string, unknown>[]
    // Only an unanswered QUOTATION is "action needed" here — a confirmed
    // order already being fulfilled ('sale'/'done') isn't something staff
    // need to chase, and treating it as urgent would leave this card
    // permanently lit for every customer with any order history at all.
    const openOrder = orders.find((r) => str(r.state) === 'draft' || str(r.state) === 'sent')
    if (openOrder) {
      return {
        kind: 'action_needed',
        label: URGENT_LABEL.action_needed,
        text: `Follow up on ${str(openOrder.name) ?? 'an open order'} — ${str(openOrder.stateLabel) ?? 'in progress'}.`,
      }
    }
  }

  const dealSection = context.sections.opportunities
  if (dealSection.state === 'available' || dealSection.state === 'partial' || dealSection.state === 'stale') {
    const deals = dealSection.records as Record<string, unknown>[]
    const openDeal = deals[0]
    if (openDeal) {
      return {
        kind: 'opportunity',
        label: URGENT_LABEL.opportunity,
        text: `${money(num(openDeal.expectedRevenue))} open on ${str(openDeal.name) ?? 'a deal'}.`,
      }
    }
  }

  if (commercialSectionsAnsweredAndEmpty(context)) {
    return {
      kind: 'day_one',
      label: URGENT_LABEL.day_one,
      text: 'No orders, invoices or deals yet — confirm their line and plan are active, and say hello.',
    }
  }

  return null
}

function UrgentCard({ signal }: { signal: UrgentSignal | null }) {
  if (!signal) return null
  return (
    <div className={`${styles.urgentCard} ${URGENT_CARD_CLASS[signal.kind]}`} data-urgent-card={signal.kind}>
      <span className={styles.urgentCardLabel}>{signal.label}</span>
      <span className={styles.urgentCardText}>{signal.text}</span>
    </div>
  )
}

function AccountCard({ context }: { context: CustomerContextResponse }) {
  const customer = context.sections.customer.records[0] as Record<string, unknown> | undefined
  const orders = context.sections.orders.records as Record<string, unknown>[]
  const invoices = context.sections.invoices.records as Record<string, unknown>[]
  const lifetimeValue = invoices.reduce((sum, r) => sum + (num(r.amountTotal) ?? 0), 0)
  const openOrders = orders.filter((r) => str(r.state) !== 'done' && str(r.state) !== 'cancel').length
  const openInvoices = invoices.filter((r) => (num(r.amountResidual) ?? 0) > 0).length

  const ordersAvailable = context.sections.orders.state === 'available' || context.sections.orders.state === 'empty'
  const invoicesAvailable =
    context.sections.invoices.state === 'available' || context.sections.invoices.state === 'empty'

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Account</h3>
      <dl className={styles.statRows}>
        <div className={styles.statRow}>
          <dt>Lifetime value</dt>
          <dd>{invoicesAvailable ? <strong>{money(lifetimeValue)}</strong> : '—'}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Open orders</dt>
          <dd>{ordersAvailable ? openOrders : '—'}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Open invoices</dt>
          <dd>{invoicesAvailable ? openInvoices : '—'}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Customer since</dt>
          <dd>{customer && str(customer.customerSince) ? shortDate(str(customer.customerSince)) : '—'}</dd>
        </div>
      </dl>
    </div>
  )
}

function OpenDealCard({ context }: { context: CustomerContextResponse }) {
  const section = context.sections.opportunities
  const deals = section.records as Record<string, unknown>[]
  const top = deals[0]

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Open deal</h3>
        {top && str(top.stage) ? <span className={styles.statusPill}>{str(top.stage)}</span> : null}
      </div>
      {section.state === 'forbidden' ? (
        <p className={styles.mutedText}>You do not have access to this section.</p>
      ) : top ? (
        <>
          <p className={styles.bigNumber}>{money(num(top.expectedRevenue))}</p>
          <p className={styles.mutedTextSmall}>{str(top.name)}{str(top.owner) ? ` · ${str(top.owner)}` : ''}</p>
        </>
      ) : section.state === 'unavailable' ? (
        <p className={styles.mutedText}>Deals is not connected: {section.reason}</p>
      ) : (
        <p className={styles.mutedText}>No open deal on record.</p>
      )}
    </div>
  )
}

function OwedCard({ context }: { context: CustomerContextResponse }) {
  const section = context.sections.invoices
  const invoices = section.records as Record<string, unknown>[]
  const owed = invoices.reduce((sum, r) => sum + (num(r.amountResidual) ?? 0), 0)
  const topUnpaid = invoices.find((r) => (num(r.amountResidual) ?? 0) > 0)

  if (section.state === 'unavailable') {
    return (
      <div className={`${styles.card} ${styles.gapNotice}`} data-gap="invoices-owed">
        <p className={styles.gapHeadline}>Amount owed — not connected.</p>
        <p className={styles.mutedText}>{section.reason}</p>
      </div>
    )
  }

  if (owed <= 0) {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>Nothing owed</p>
        <p className={styles.mutedTextSmall}>Every invoice on record is paid.</p>
      </div>
    )
  }

  return (
    <div className={styles.owedCard}>
      <p className={styles.owedAmount}>{money(owed)} owed</p>
      <p className={styles.owedMeta}>
        {topUnpaid ? `${str(topUnpaid.name)} · due ${shortDate(str(topUnpaid.dueDate))}` : 'Across open invoices'}
      </p>
    </div>
  )
}

/**
 * dec-CC-DISPATCH-app-support-phase-B-line-context-panel-2026-09-02: the
 * Personal Line half of the same shared workspace this file already renders
 * for an Odoo business customer. `personalLine.data.state` decides the
 * whole card — a plain business customer (`not-a-personal-line-customer`)
 * renders nothing here, the same way OpenDealCard/ChatCard already omit
 * content that doesn't apply, rather than a permanent "gap" notice for a
 * product this customer never had. A REAL failure (`unavailable` /
 * `not-connected`) still gets the GapCard treatment every other honest gap
 * on this screen uses — that is a source that broke, not an axis that
 * doesn't apply.
 */
function PersonalLineCard({ context }: { context: CustomerContextResponse }) {
  const line = context.personalLine.data

  if (line.state === 'not-a-personal-line-customer') return null

  if (line.state === 'no-phone-on-file') {
    return (
      <div className={`${styles.card} ${styles.gapNotice}`} data-gap="personal-line-no-phone">
        <p className={styles.gapHeadline}>Personal Line — could not check.</p>
        <p className={styles.mutedText}>This customer&rsquo;s Odoo record has no phone on file to look up.</p>
      </div>
    )
  }

  if (line.state === 'not-connected' || line.state === 'unavailable') {
    return (
      <GapCard
        title="Personal Line"
        reason={line.reason}
        whatItNeeds="bff-v2's /api/internal/lite/context, reachable and configured (BFF_BASE_URL / BFF_INTERNAL_SECRET)."
      />
    )
  }

  if (line.state === 'ambiguous') {
    return (
      <div className={`${styles.card} ${styles.gapNotice}`} data-gap="personal-line-ambiguous">
        <p className={styles.gapHeadline}>Personal Line — more than one match.</p>
        <p className={styles.mutedText}>
          {line.count} Personal Line accounts share this phone number. Refusing to guess which one this is —
          resolve the duplicate before showing line data here.
        </p>
      </div>
    )
  }

  // line.state === 'found'
  const statusLabel =
    line.status === 'active'
      ? 'Active'
      : line.status === 'blocked'
        ? 'Blocked'
        : line.status === 'not_provisioned'
          ? 'Not provisioned'
          : 'Unknown'
  const planLabel = line.plan
    ? `${line.plan.planId} · ${line.plan.state}${line.plan.autoRenew ? ' · auto-renew' : ''} · expires ${shortDate(line.plan.expiresAt)}`
    : 'No active plan on record'

  return (
    <div className={styles.card} data-personal-line="true">
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Personal Line</h3>
        <span className={styles.statusPill}>{statusLabel}</span>
      </div>
      <dl className={styles.statRows}>
        <div className={styles.statRow}>
          <dt>Number</dt>
          <dd>{line.did ?? '—'}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Wallet balance</dt>
          <dd>{money(line.balanceEc)}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Plan</dt>
          <dd>{planLabel}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Routing</dt>
          <dd>{line.routingMode}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Signed up</dt>
          <dd>{shortDate(line.signupAt)}</dd>
        </div>
      </dl>
      {line.recentActivityUnavailable ? (
        <p className={styles.mutedText}>Recent calls could not be read — this is an outage, not a quiet line.</p>
      ) : line.recent.length === 0 ? (
        <p className={styles.mutedTextSmall}>No recent calls on record.</p>
      ) : (
        <ul className={styles.statRows}>
          {line.recent.map((c, i) => (
            <li key={`${c.at}-${i}`} className={styles.statRow}>
              <dt>{shortDate(c.at)}</dt>
              <dd>{c.label}</dd>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function GapCard({ title, reason, whatItNeeds }: { title: string; reason: string; whatItNeeds: string }) {
  return (
    <div className={`${styles.card} ${styles.gapNotice}`} data-gap={title}>
      <p className={styles.gapHeadline}>{title} — not connected.</p>
      <p className={styles.mutedText}>{reason}</p>
      <p className={styles.mutedText}>
        <strong>What would close this: </strong>
        {whatItNeeds}
      </p>
    </div>
  )
}

/** Step D: the day-one layout. "Empty is a layout, not an absence" — when
 *  Odoo's commercial panels are genuinely empty, lead with what the
 *  customer DOES have (line, customer-since) rather than a grid of empty
 *  cards. Plan/wallet used to be a permanent named gap here; it is now a
 *  real read (see PersonalLineCard) — a day-one customer who is ALSO a
 *  Personal Line subscriber sees their real line data in the same place a
 *  fabricated placeholder used to sit. */
function DayOneCard({ context }: { context: CustomerContextResponse }) {
  const customer = context.sections.customer.records[0] as Record<string, unknown> | undefined
  return (
    <div className={styles.card} data-day-one="true">
      <h3 className={styles.cardTitle}>New customer — what they have so far</h3>
      <dl className={styles.statRows}>
        <div className={styles.statRow}>
          <dt>Line</dt>
          <dd>{customer && str(customer.phone) ? str(customer.phone) : '—'}</dd>
        </div>
        <div className={styles.statRow}>
          <dt>Customer since</dt>
          <dd>{customer && str(customer.customerSince) ? shortDate(str(customer.customerSince)) : '—'}</dd>
        </div>
      </dl>
      <PersonalLineCard context={context} />
    </div>
  )
}

/** Step B's resolver, surfaced on Overview — replaces what used to be a
 *  flat "not built" gap card now that resolving-by-phone is real. Reading
 *  the conversation's own messages is still a genuine gap (Chatwoot's bot
 *  API cannot list messages), named honestly rather than implied done. */
function ChatCard({
  resolution,
  onOpenComposer,
}: {
  resolution: ConversationResolutionView
  onOpenComposer: () => void
}) {
  const statusText =
    resolution.status === 'found' && resolution.chatwootDeepLink === null
      ? `Resolved to an existing Chatwoot conversation${resolution.chatwootConversationId !== null ? ` (#${resolution.chatwootConversationId})` : ''} — its inbox isn't linked to this workspace yet.`
      : resolution.status === 'found'
      ? `Resolved to an existing Chatwoot conversation${resolution.chatwootConversationId !== null ? ` (#${resolution.chatwootConversationId})` : ''}.`
      : resolution.status === 'not_found'
        ? 'No Chatwoot conversation found yet for this phone number.'
        : resolution.status === 'loading'
          ? 'Resolving…'
          : resolution.status === 'error'
            ? 'Could not be resolved right now — this is an outage, not a verdict.'
            : 'Not yet resolved — message this customer to resolve it.'

  return (
    <div className={styles.card} data-chat-card="true">
      <h3 className={styles.cardTitle}>Chat</h3>
      <p className={styles.mutedTextSmall}>{statusText}</p>
      <p className={styles.mutedText}>
        Reading this conversation&rsquo;s recent messages is still a gap — Chatwoot&rsquo;s bot API cannot list
        messages read-only.
      </p>
      <div className={styles.sheetActions}>
        <button type="button" className={styles.secondaryButton} onClick={onOpenComposer}>
          Message
        </button>
        {resolution.chatwootDeepLink ? (
          <a href={resolution.chatwootDeepLink} target="_blank" rel="noreferrer noopener" className={styles.secondaryLink}>
            Open in Chatwoot ↗
          </a>
        ) : null}
      </div>
    </div>
  )
}

function OverviewTab({
  context,
  onSelectTab,
  conversationResolution,
  onOpenMessageComposer,
}: {
  context: CustomerContextResponse
  onSelectTab: (tab: WorkspaceTabName) => void
  conversationResolution: ConversationResolutionView
  onOpenMessageComposer: () => void
}) {
  const nba = nextBestAction(context)
  const dayOne = commercialSectionsAnsweredAndEmpty(context)

  return (
    <div className={styles.overviewGrid}>
      {nba ? (
        <div className={styles.nextBestAction}>
          <div>
            <span className={styles.nbaLabel}>NEXT BEST ACTION</span>
            <p className={styles.nbaText}>{nba.text}</p>
          </div>
          <button type="button" className={styles.primaryButton} onClick={() => onSelectTab(nba.targetTab)}>
            Open {TAB_LABEL[nba.targetTab]}
          </button>
        </div>
      ) : null}

      <div className={styles.overviewColumn}>
        <GapCard
          title="AI insights"
          reason="No analytics/aggregation source exists in Foundation yet."
          whatItNeeds="A service that computes trend and reorder-cadence signals from Orders/Invoices history, gated on a minimum evidence bar (per design/CUSTOMER-360-DESIGN-STUDY.md §5.3) — none exists today; this is new engineering, not a missing field."
        />
        <GapCard
          title="Follow-ups"
          reason="tasks are not connected: no customer relationship on project.task has been established for this instance"
          whatItNeeds="mail.activity is the more promising real source (named directly in dec-c360-design-defines-the-target-find-the-data-2026-09-04) — not yet tried."
        />
      </div>

      <div className={styles.overviewColumn}>
        {dayOne ? (
          <DayOneCard context={context} />
        ) : (
          <>
            <AccountCard context={context} />
            <OpenDealCard context={context} />
            <PersonalLineCard context={context} />
          </>
        )}
      </div>

      <div className={styles.overviewColumn}>
        {dayOne ? null : <OwedCard context={context} />}
        <ChatCard resolution={conversationResolution} onOpenComposer={onOpenMessageComposer} />
      </div>
    </div>
  )
}

/* ── Timeline: best-effort merge of what IS wired ──────────────────────────*/

function TimelineTab({ context }: { context: CustomerContextResponse }) {
  type Row = { key: string; date: string | null; title: string; meta: string; amount: number | null; status: string | null }
  const rows: Row[] = []

  for (const name of ['orders', 'invoices', 'opportunities', 'issues'] as const) {
    const section = context.sections[name]
    if (section.state !== 'available' && section.state !== 'partial' && section.state !== 'stale') continue
    for (const r of section.records as Record<string, unknown>[]) {
      rows.push({
        key: `${name}-${r.id}`,
        date: recordDate(r),
        title: recordTitle(r),
        meta: SECTION_LABEL[name],
        amount: recordAmount(r),
        status: recordStatus(r),
      })
    }
  }
  rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const notMerged: string[] = []
  if (context.sections.calls.state === 'unavailable') notMerged.push('calls')
  notMerged.push('conversation messages (mail.message not yet read)')

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Timeline</h3>
      <p className={styles.mutedTextSmall}>Not included yet: {notMerged.join(', ')} — see their own tabs for why.</p>
      {rows.length === 0 ? (
        <p className={styles.mutedText}>Nothing recorded yet across orders, invoices, deals or tickets.</p>
      ) : (
        <ul className={styles.listRows}>
          {rows.map((r) => (
            <li key={r.key} className={styles.listRow}>
              <div className={styles.listRowMain}>
                <div className={styles.listRowTitle}>{r.title}</div>
                <div className={styles.listRowMeta}>
                  {[r.meta, r.date ? shortDate(r.date) : null, r.amount !== null ? money(r.amount) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {r.status ? <span className={styles.statusPill}>{r.status}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ── section card (kept for tests/back-compat with the pre-8-tab component) ── */

export function SectionCard({ section }: { section: ContextSectionEnvelope }) {
  return <ListTab section={section} tab="orders" onSelectRecord={() => {}} />
}

export function NativeSurface({ name, reason }: { name: string; system: string; reason: string }) {
  return <GapCard title={name} reason={reason} whatItNeeds="A per-customer authoritative reference for this system." />
}

/* ── lifecycle ─────────────────────────────────────────────────────────────*/

export function LifecycleBadge({ state }: { state: ActionLifecycleState }) {
  const p = LIFECYCLE_PRESENTATION[state]
  return (
    <span data-lifecycle={state} data-tone={p.tone} data-success={String(p.success)} className="text-sm font-medium">
      <span aria-hidden="true">{p.marker} </span>
      {p.label}
    </span>
  )
}

export function retryWriteSentence(outcome: ActionOutcomeView): string {
  if (outcome.retryWrite === 'safe') return 'safe — nothing was written'
  if (outcome.retryWrite !== 'unsafe') return 'not applicable'
  return mayHaveWritten(outcome.lifecycle)
    ? 'not safe — it may write a second time'
    : 'not safe — but nothing was written; the same request would be refused again'
}

/* ── the workbench, before anything is sent ────────────────────────────────*/

function FieldInput({
  field,
  value,
  onChangeField,
}: {
  field: ActionField
  value: string
  onChangeField: (name: string, value: string) => void
}) {
  const id = `action-field-${field.name}`
  const describedBy = field.help ? `${id}-help` : undefined
  const common = {
    id,
    name: field.name,
    value,
    'aria-describedby': describedBy,
    required: field.required,
    className: 'min-h-11 w-full rounded-md border px-3 py-2 text-sm',
    onChange: (e: { target: { value: string } }) => onChangeField(field.name, e.target.value),
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-muted-foreground"> (required)</span> : null}
      </label>
      {field.kind === 'longtext' ? (
        <textarea {...common} rows={4} maxLength={field.maxLength} />
      ) : field.kind === 'choice' ? (
        <select {...common}>
          <option value="">Choose…</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type={field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'}
          maxLength={field.maxLength}
        />
      )}
      {field.help ? (
        <p id={describedBy} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      ) : null}
    </div>
  )
}

export function ActionPlan({
  action,
  customerLabel,
  values,
  pending,
  onChangeField,
  onRun,
}: {
  action: AvailableAction
  customerLabel: string
  values: Record<string, string>
  pending: boolean
  onChangeField: (name: string, value: string) => void
  onRun: () => void
}) {
  const supplied = action.fields.filter((f) => (values[f.name] ?? '').trim().length > 0)
  const unknown = Object.keys(values).filter((k) => !action.fields.some((f) => f.name === k))

  return (
    <div className="flex flex-col gap-4" data-action-plan={action.actionType}>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Customer</dt>
          <dd>{customerLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Action</dt>
          <dd>{action.label}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Target system</dt>
          <dd>The business system of record</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Risk</dt>
          <dd>{action.riskLevel}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">What this will write</dt>
          <dd>{action.writes}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Required permission</dt>
          <dd>
            {action.requiresApproval
              ? 'Your role permits this, and it also needs a person to approve it before it can run.'
              : 'Your role permits this and no separate approval is required.'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Expected result</dt>
          <dd>{action.expectedResult}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">If it goes wrong</dt>
          <dd>
            Nothing is reported as done until it has been read back. If it is
            written and cannot be read back, you will be told exactly that and
            asked to check the system of record — it will not be undone
            automatically.
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-3">
        {action.fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            onChangeField={onChangeField}
          />
        ))}
      </div>

      <div className="text-xs text-muted-foreground" data-supplied-count={supplied.length}>
        Supplied: {supplied.length > 0 ? supplied.map((f) => f.label).join(', ') : 'nothing yet'}
        {unknown.length > 0 ? ` · Not used by this action: ${unknown.join(', ')}` : ''}
      </div>

      <button
        type="button"
        onClick={onRun}
        disabled={pending}
        className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
      >
        {pending ? 'Sending…' : action.requiresApproval ? 'Request approval' : 'Send to the system of record'}
      </button>
    </div>
  )
}

/* ── the workbench, afterwards ─────────────────────────────────────────────*/

export function ActionResult({ outcome }: { outcome: ActionOutcomeView }) {
  const p = LIFECYCLE_PRESENTATION[outcome.lifecycle]

  return (
    <div
      className="mt-4 rounded-md border p-3"
      data-action-result={outcome.lifecycle}
      data-success={String(outcome.success)}
      role="status"
      aria-live={p.escalate ? 'assertive' : 'polite'}
    >
      <LifecycleBadge state={outcome.lifecycle} />
      <p className="mt-1 text-sm">{p.sentence}</p>
      {outcome.detail && outcome.detail !== p.sentence ? (
        <p className="mt-1 text-sm text-muted-foreground">{outcome.detail}</p>
      ) : null}
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Operation reference</dt>
          <dd>{outcome.operationId ?? 'none — nothing was recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Audit reference</dt>
          <dd>{outcome.auditRef ?? 'none'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Read back from the system of record</dt>
          <dd>{outcome.readbackProven ? 'yes — this is confirmed' : 'no — this is not confirmed'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sending it again</dt>
          <dd>{retryWriteSentence(outcome)}</dd>
        </div>
        {outcome.approvalRef ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Approval reference</dt>
            <dd>{outcome.approvalRef}</dd>
          </div>
        ) : null}
      </dl>
      {outcome.showsPriorResult ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This result belongs to an earlier attempt with the same reference.
        </p>
      ) : null}
      {outcome.escalate ? (
        <p className="mt-2 text-sm font-medium">
          A person needs to check the system of record before this is treated as done.
        </p>
      ) : null}
    </div>
  )
}

/* ── the whole screen ──────────────────────────────────────────────────────*/

export function CustomerWorkspaceView(props: WorkspaceViewProps) {
  const { context } = props

  if (props.status === 'loading') {
    return (
      <div id="customer-workspace" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading this customer…</p>
      </div>
    )
  }

  if (props.status === 'not_found') {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">Not available</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This customer was not found, or is not available to you.
        </p>
      </div>
    )
  }

  if (props.status === 'forbidden') {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">Not available for your role</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask a workspace owner to grant you access if you need it.
        </p>
      </div>
    )
  }

  if (props.status === 'error' || !context) {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">This customer could not be loaded</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {props.errorDetail ?? 'The workspace could not be read. Nothing about this customer has changed.'}
        </p>
        <button
          type="button"
          onClick={props.onRetryContext}
          className="mt-3 min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    )
  }

  const customerSection = context.sections.customer
  const customerRecord = (customerSection.records[0] ?? null) as Record<string, unknown> | null
  const customerLabel = customerRecord ? recordTitle(customerRecord) : 'This customer'
  const selected = context.availableActions.find((a) => a.actionType === props.selectedAction) ?? null
  const initial = customerLabel.slice(0, 2).toUpperCase()

  const tabCount = (tab: WorkspaceTabName): number | null => {
    const name = TAB_SECTION[tab]
    if (!name) return null
    const s = context.sections[name]
    return s.state === 'available' || s.state === 'partial' || s.state === 'stale' ? s.count : null
  }

  // Step A: is a record's in-app detail sheet open, and does it belong to
  // the tab currently being rendered?
  const openSheetFor = (tab: WorkspaceTabName): Record<string, unknown> | null => {
    if (!props.selectedRecord || props.selectedRecord.tab !== tab) return null
    const sectionName = TAB_SECTION[tab]
    if (!sectionName) return null
    const records = context.sections[sectionName].records as Record<string, unknown>[]
    return records.find((r) => r.id === props.selectedRecord!.id) ?? null
  }

  return (
    <div id="customer-workspace" className={styles.root}>
      {/* ── identity bar ───────────────────────────────────────────────── */}
      <header id="customer-workspace-identity-bar" className={styles.identityBar}>
        <div className={styles.identityLeft}>
          <div className={styles.avatar} aria-hidden="true">
            {initial}
          </div>
          <div>
            <h2 id="customer-workspace-title" className={styles.identityBarTitle}>
              {customerLabel}
            </h2>
            <p className={styles.identityBarMeta}>
              {customerRecord && str(customerRecord.companyName)
                ? str(customerRecord.companyName)
                : customerRecord && customerRecord.isCompany === true
                  ? 'Company record'
                  : 'No parent company recorded'}
              {customerRecord && str(customerRecord.phone) ? ` · ${str(customerRecord.phone)}` : ''}
            </p>
          </div>
        </div>
        <div className={styles.identityRight}>
          <UrgentCard signal={urgentSignal(context)} />
          <div className={styles.identityRightButtons}>
            <button type="button" className={styles.secondaryButton}>
              Call
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              aria-pressed={props.messageComposerOpen}
              onClick={props.onOpenMessageComposer}
            >
              Message
            </button>
          </div>
        </div>
      </header>

      {props.messageComposerOpen ? (
        <MessageComposer
          draftText={props.messageDraftText}
          resolution={props.conversationResolution}
          onChangeDraft={props.onChangeMessageDraft}
          onClose={props.onCloseMessageComposer}
        />
      ) : null}

      {context.provenance.degraded.length > 0 ? (
        <div role="status" className={styles.incompleteBanner} data-incomplete="true">
          <span aria-hidden="true">⚠ </span>
          This is an incomplete picture. These sections could not be read:{' '}
          {context.provenance.degraded.map((d) => SECTION_LABEL[d]).join(', ')}.
        </div>
      ) : null}

      {/* ── tab row ────────────────────────────────────────────────────── */}
      <div role="tablist" aria-label="Customer sections" className={styles.tabRow}>
        {TAB_ORDER.map((tab) => {
          const count = tabCount(tab)
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={props.selectedTab === tab}
              data-tab={tab}
              className={props.selectedTab === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => props.onSelectTab(tab)}
            >
              {TAB_LABEL[tab]}
              {count !== null && count > 0 ? <span className={styles.tabCount}>{count}</span> : null}
            </button>
          )
        })}
      </div>

      {/* ── body: every tab's content stays in the markup, only display is gated ── */}
      <div className={styles.body}>
        {TAB_ORDER.map((tab) => {
          const openRecord = openSheetFor(tab)
          const kind = detailKindFor(tab)

          return (
            <div
              key={tab}
              role="tabpanel"
              aria-hidden={props.selectedTab !== tab}
              data-tab-panel={tab}
              className={props.selectedTab === tab ? styles.tabPanelActive : styles.tabPanel}
            >
              {openRecord && kind ? (
                <RecordDetailSheet
                  customerLabel={customerLabel}
                  kind={kind}
                  record={openRecord}
                  subTab={props.selectedRecordSubTab}
                  lines={props.recordLines}
                  linesStatus={props.recordLinesStatus}
                  odooLink={str(openRecord.link)}
                  onBack={props.onBackFromRecord}
                  onSelectSubTab={props.onSelectRecordSubTab}
                  onOpenMessageComposer={props.onOpenMessageComposer}
                />
              ) : tab === 'overview' ? (
                <OverviewTab
                  context={context}
                  onSelectTab={props.onSelectTab}
                  conversationResolution={props.conversationResolution}
                  onOpenMessageComposer={props.onOpenMessageComposer}
                />
              ) : tab === 'timeline' ? (
                <TimelineTab context={context} />
              ) : tab === 'invoices' ? (
                <InvoiceAgingTab
                  section={context.sections.invoices}
                  expandedBuckets={props.expandedInvoiceBuckets}
                  onToggleBucket={props.onToggleInvoiceBucket}
                  onSelectRecord={props.onSelectRecord}
                />
              ) : TAB_SECTION[tab] ? (
                <ListTab section={context.sections[TAB_SECTION[tab]!]} tab={tab} onSelectRecord={props.onSelectRecord} />
              ) : null}
            </div>
          )
        })}
      </div>

      {/* ── the governed action workbench ──────────────────────────────── */}
      <section aria-labelledby="workbench-title" className={styles.card}>
        <h3 id="workbench-title" className={styles.cardTitle}>
          Governed actions
        </h3>
        <p className={styles.mutedText}>
          Nothing is reported as done until it has been read back from the system of record.
        </p>

        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby="workbench-title">
          {context.availableActions.map((action) => (
            <button
              key={action.actionType}
              type="button"
              onClick={() => props.onSelectAction(action.actionType)}
              aria-pressed={props.selectedAction === action.actionType}
              data-action={action.actionType}
              className="min-h-11 rounded-md border px-3 py-2 text-sm"
            >
              {action.label}
              {action.requiresApproval ? ' (needs approval)' : ''}
            </button>
          ))}
        </div>

        {selected ? (
          <div className="mt-4 border-t pt-4">
            <ActionPlan
              action={selected}
              customerLabel={customerLabel}
              values={props.actionValues}
              pending={props.actionPending}
              onChangeField={props.onChangeField}
              onRun={props.onRun}
            />
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Choose an action to see exactly what it would write before anything is sent.
          </p>
        )}

        {props.actionOutcome ? <ActionResult outcome={props.actionOutcome} /> : null}
      </section>
    </div>
  )
}
