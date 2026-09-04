/**
 * customer-sources@1 — where the Customer 360 workspace's context actually
 * comes from.
 *
 * Two halves:
 *
 *   READERS — bounded, fixed-purpose Odoo reads. Every one of them fixes its
 *   model, method, domain, returned fields, ordering and limit IN CODE. A
 *   caller supplies which customer, and nothing else. This is the discipline
 *   lib/customer-tools/lookup.ts established, and its reasoning applies here
 *   unchanged: json2Call can call any model with any method and any domain, so
 *   the moment any of that becomes caller-supplied, the allowlist is gone.
 *
 *   ADAPTERS — BundleAdapter implementations over those readers, plus an
 *   explicit refusal for every section that has no identified source. A section
 *   nobody can answer is `unavailable`. It is never `empty`, and it is never
 *   simply left out.
 */

import { json2Call, type OdooConfig } from '@/engines/odoo'
import { LEAD_FIELDS } from '@/lib/customer-tools/lookup'

import { classifyOdooFailure } from './odoo-failure'
import { limitOdooReads, normaliseInstanceKey } from './odoo-read-limiter'
import type { BundleAdapter, BundleSection, Provenance } from './context-bundle'

export const CUSTOMER_SOURCES_VERSION = 'customer-sources@1' as const

/** Wall-clock guard on every read. An Odoo that never answers must not hang a page. */
export const ODOO_READ_TIMEOUT_MS = 10_000

/** Hard ceiling per section, independent of what the caller asks for. */
export const MAX_SECTION_ROWS = 50

/**
 * The transport, injected. Tests exercise every failure path without a network,
 * and nothing in this module can reach a different Odoo than the one it was
 * handed.
 */
export type OdooCaller = (
  model: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

/**
 * The one door every bounded Customer 360 read goes through — which is why the
 * per-instance concurrency limit belongs here and nowhere else.
 *
 * `buildContextBundle` fans its adapters out with `Promise.all`, so four Odoo
 * reads used to leave together and production returned HTTP 429 for one of them
 * while the other three succeeded. `limitOdooReads` keys on the instance URL,
 * so reads to one Odoo queue behind each other and reads to a DIFFERENT Odoo —
 * another tenant's — are entirely unaffected.
 *
 * WRITES DO NOT PASS THROUGH HERE. `lib/governed/executors/odoo-record-system.ts`
 * builds its own caller straight onto `json2Call`. That is deliberate and is
 * left alone: a governed write is a single deliberate act, not a fan-out, and
 * putting it behind a read queue would make a staff member wait on a page
 * refresh to record a note.
 */
export function odooCallerFor(config: OdooConfig): OdooCaller {
  const instanceKey = normaliseInstanceKey(config.url)
  return (model, method, params) =>
    limitOdooReads(instanceKey, () =>
      json2Call(config, model, method, params, ODOO_READ_TIMEOUT_MS),
    )
}

/* ── failure wording ────────────────────────────────────────────────────────
 *
 * Odoo and its driver write for engineers: hostnames, database names, SQL. None
 * of that belongs on a workbench screen. The sentences live in
 * `./odoo-failure.ts`, which also decides WHICH sentence — a distinction that
 * used to be made here and got it wrong: a transient 5xx was reported as "this
 * Odoo plan does not expose the external API", a permanent condition, while
 * three other reads of the same instance succeeded in the same request.
 *
 * The signature is unchanged so every existing caller keeps working.
 */

export function sanitiseOdooFailure(err: unknown): string {
  return classifyOdooFailure(err).message
}

/* ── row helpers ────────────────────────────────────────────────────────────*/

/** Odoo many2one comes back as [id, name] or {id, display_name} by version. */
function nameOf(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 1) return typeof value[1] === 'string' ? value[1] : null
  if (value && typeof value === 'object') {
    const dn = (value as { display_name?: unknown }).display_name
    return typeof dn === 'string' ? dn : null
  }
  return null
}

function idOf(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0]
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    return typeof id === 'number' ? id : null
  }
  return null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : [])

function clampLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_SECTION_ROWS)
}

/**
 * A customer id arrives from a URL. Odoo record ids are positive integers, and
 * anything else must be refused BEFORE it reaches a domain — not because Odoo
 * would necessarily misbehave, but because a domain is the last place to start
 * trusting input.
 */
export function parseCustomerId(raw: unknown): number | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^[1-9]\d{0,17}$/.test(s)) return null
  return Number(s)
}

/* ── readers ────────────────────────────────────────────────────────────────*/

/**
 * res.partner. Only the fields the workspace header names: who they are, how to
 * reach them, whether they are a company or sit under one, and whether the
 * record is still active. `active` is the closest thing res.partner has to an
 * account status; nothing here invents one.
 */
export const PARTNER_FIELDS = [
  'id',
  'name',
  'email',
  'phone',
  'city',
  'street',
  'is_company',
  'parent_id',
  'active',
  'create_date',
] as const

export interface CustomerRecord {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  city: string | null
  street: string | null
  isCompany: boolean
  companyName: string | null
  active: boolean
  customerSince: string | null
}

export async function readCustomer(
  call: OdooCaller,
  customerId: number,
): Promise<CustomerRecord[]> {
  const result = await call('res.partner', 'search_read', {
    domain: [['id', '=', customerId]],
    fields: [...PARTNER_FIELDS],
    limit: 1,
  })
  return rows(result).map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    email: str(r.email),
    phone: str(r.phone),
    city: str(r.city),
    street: str(r.street),
    // Missing defaults to TRUE — see the note in customer-search.ts. Both
    // surfaces must answer this the same way or the same customer reads as a
    // person in one place and a company in the other.
    isCompany: r.is_company !== false,
    companyName: nameOf(r.parent_id),
    active: r.active !== false,
    customerSince: str(r.create_date),
  }))
}

/**
 * Contacts are the partner's OWN children — `parent_id = customerId`. Nothing
 * broader. A name-based or company-based match would pull in partners this
 * customer has no relationship to, and on a workbench that reads as disclosure.
 */
export const CONTACT_FIELDS = ['id', 'name', 'email', 'phone', 'function'] as const

export interface ContactRecord {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  role: string | null
}

export async function readContacts(
  call: OdooCaller,
  customerId: number,
  limit: number,
): Promise<ContactRecord[]> {
  const result = await call('res.partner', 'search_read', {
    domain: [
      ['parent_id', '=', customerId],
      ['active', '=', true],
    ],
    fields: [...CONTACT_FIELDS],
    order: 'name asc',
    limit: clampLimit(limit),
  })
  return rows(result).map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    email: str(r.email),
    phone: str(r.phone),
    role: str(r.function),
  }))
}

/**
 * crm.lead, through the allowlist lookup.ts already fixed and reviewed. It is
 * imported rather than restated so this section cannot drift wider than the one
 * that was signed off — that list deliberately excludes every internal free-text
 * field, because an agent reading internal deal commentary back to the customer
 * it is about is a disclosure incident waiting for a slow day.
 */
export interface OpportunityRecord {
  id: number
  name: string | null
  kind: string | null
  stage: string | null
  owner: string | null
  expectedRevenue: number | null
  deadline: string | null
  updatedAt: string | null
}

export async function readOpportunities(
  call: OdooCaller,
  customerId: number,
  limit: number,
): Promise<OpportunityRecord[]> {
  const result = await call('crm.lead', 'search_read', {
    domain: [['partner_id', '=', customerId]],
    fields: [...LEAD_FIELDS],
    order: 'write_date desc',
    limit: clampLimit(limit),
  })
  return rows(result).map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    kind: str(r.type),
    stage: nameOf(r.stage_id),
    owner: nameOf(r.user_id),
    expectedRevenue: typeof r.expected_revenue === 'number' ? r.expected_revenue : null,
    deadline: str(r.date_deadline),
    updatedAt: str(r.write_date),
  }))
}

/**
 * helpdesk.ticket. If the model is not installed on this instance the read
 * throws and the section becomes `unavailable` naming that — which is the right
 * answer, and is why this reader is safe to ship without first proving the model
 * exists. What it must never do is come back empty.
 */
export const ISSUE_FIELDS = [
  'id',
  'name',
  'stage_id',
  'priority',
  'user_id',
  'create_date',
  'write_date',
] as const

export interface IssueRecord {
  id: number
  name: string | null
  stage: string | null
  priority: string | null
  owner: string | null
  openedAt: string | null
  updatedAt: string | null
}

export async function readIssues(
  call: OdooCaller,
  customerId: number,
  limit: number,
): Promise<IssueRecord[]> {
  const result = await call('helpdesk.ticket', 'search_read', {
    domain: [['partner_id', '=', customerId]],
    fields: [...ISSUE_FIELDS],
    order: 'write_date desc',
    limit: clampLimit(limit),
  })
  return rows(result).map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    stage: nameOf(r.stage_id),
    priority: str(r.priority),
    owner: nameOf(r.user_id),
    openedAt: str(r.create_date),
    updatedAt: str(r.write_date),
  }))
}

/**
 * sale.order. The order-side twin of readOpportunities: only fields already
 * safe to show a workbench (no internal margin/costing fields), scoped to
 * `partner_id = customerId` exactly, same as every other reader here.
 */
export const ORDER_FIELDS = [
  'id',
  'name',
  'state',
  'amount_total',
  'date_order',
  'commitment_date',
  'invoice_status',
] as const

const ORDER_STATE_LABEL: Readonly<Record<string, string>> = {
  draft: 'Quotation',
  sent: 'Quotation sent',
  sale: 'Confirmed',
  done: 'Delivered',
  cancel: 'Cancelled',
}

export interface OrderRecord {
  id: number
  name: string | null
  /** Raw sale.order.state (draft|sent|sale|done|cancel) — what
   *  lib/customer-workspace/record-stage.ts's orderStageIndex() needs.
   *  Never shown to a reader directly; see stateLabel. */
  state: string | null
  /** The customer-facing label (Quotation/Confirmed/Delivered/Cancelled) —
   *  what a row or header actually displays. */
  stateLabel: string | null
  amountTotal: number | null
  orderedAt: string | null
  deliveryDate: string | null
  invoiceStatus: string | null
}

export async function readOrders(
  call: OdooCaller,
  customerId: number,
  limit: number,
): Promise<OrderRecord[]> {
  const result = await call('sale.order', 'search_read', {
    domain: [['partner_id', '=', customerId]],
    fields: [...ORDER_FIELDS],
    order: 'date_order desc',
    limit: clampLimit(limit),
  })
  return rows(result).map((r) => {
    const rawState = str(r.state)
    return {
      id: Number(r.id),
      name: str(r.name),
      state: rawState,
      stateLabel: rawState ? (ORDER_STATE_LABEL[rawState] ?? rawState) : null,
      amountTotal: typeof r.amount_total === 'number' ? r.amount_total : null,
      orderedAt: str(r.date_order),
      deliveryDate: str(r.commitment_date),
      invoiceStatus: str(r.invoice_status),
    }
  })
}

/**
 * account.move, restricted to customer invoices (`move_type = 'out_invoice'`)
 * so a vendor bill on the same partner record never surfaces here — this
 * section is what THIS customer owes EPIC, never the reverse.
 */
export const INVOICE_FIELDS = [
  'id',
  'name',
  'state',
  'payment_state',
  'amount_total',
  'amount_residual',
  'invoice_date',
  'invoice_date_due',
] as const

const PAYMENT_STATE_LABEL: Readonly<Record<string, string>> = {
  not_paid: 'Open',
  in_payment: 'In payment',
  paid: 'Paid',
  partial: 'Partially paid',
  reversed: 'Reversed',
  invoicing_legacy: 'Legacy',
}

export interface InvoiceRecord {
  id: number
  name: string | null
  state: string | null
  paymentState: string | null
  amountTotal: number | null
  amountResidual: number | null
  invoiceDate: string | null
  dueDate: string | null
}

export async function readInvoices(
  call: OdooCaller,
  customerId: number,
  limit: number,
): Promise<InvoiceRecord[]> {
  const result = await call('account.move', 'search_read', {
    domain: [
      ['partner_id', '=', customerId],
      ['move_type', '=', 'out_invoice'],
      ['state', '!=', 'draft'],
    ],
    fields: [...INVOICE_FIELDS],
    order: 'invoice_date desc',
    limit: clampLimit(limit),
  })
  return rows(result).map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    state: str(r.state),
    paymentState: str(r.payment_state) ? (PAYMENT_STATE_LABEL[String(r.payment_state)] ?? str(r.payment_state)) : null,
    amountTotal: typeof r.amount_total === 'number' ? r.amount_total : null,
    amountResidual: typeof r.amount_residual === 'number' ? r.amount_residual : null,
    invoiceDate: str(r.invoice_date),
    dueDate: str(r.invoice_date_due),
  }))
}

/**
 * sale.order.line, for the in-app order detail sheet's "Line items" sub-tab.
 * Scoped to `order_id = orderId` exactly — a caller supplies which order,
 * nothing else. Excludes section/note display lines (`display_type` set),
 * which carry no product/price and would render as empty rows.
 */
export const ORDER_LINE_FIELDS = ['id', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal', 'display_type'] as const

export interface OrderLineRecord {
  id: number
  name: string | null
  quantity: number | null
  unitPrice: number | null
  subtotal: number | null
}

export async function readOrderLines(call: OdooCaller, orderId: number): Promise<OrderLineRecord[]> {
  const result = await call('sale.order.line', 'search_read', {
    domain: [['order_id', '=', orderId]],
    fields: [...ORDER_LINE_FIELDS],
    limit: MAX_SECTION_ROWS,
  })
  return rows(result)
    .filter((r) => !r.display_type)
    .map((r) => ({
      id: Number(r.id),
      name: str(r.name),
      quantity: typeof r.product_uom_qty === 'number' ? r.product_uom_qty : null,
      unitPrice: typeof r.price_unit === 'number' ? r.price_unit : null,
      subtotal: typeof r.price_subtotal === 'number' ? r.price_subtotal : null,
    }))
}

/**
 * account.move.line, for the in-app invoice detail sheet's "Lines" sub-tab.
 * Same exclusion of section/note display lines as readOrderLines, plus the
 * "exclude_from_invoice_tab" flag Odoo sets on tax/rounding lines that
 * accounting logic needs but a customer-facing line-item view should not
 * show as if they were purchased items.
 */
export const INVOICE_LINE_FIELDS = ['id', 'name', 'quantity', 'price_unit', 'price_subtotal', 'display_type', 'exclude_from_invoice_tab'] as const

export interface InvoiceLineRecord {
  id: number
  name: string | null
  quantity: number | null
  unitPrice: number | null
  subtotal: number | null
}

export async function readInvoiceLines(call: OdooCaller, invoiceId: number): Promise<InvoiceLineRecord[]> {
  const result = await call('account.move.line', 'search_read', {
    domain: [['move_id', '=', invoiceId]],
    fields: [...INVOICE_LINE_FIELDS],
    limit: MAX_SECTION_ROWS,
  })
  return rows(result)
    .filter((r) => !r.display_type && !r.exclude_from_invoice_tab)
    .map((r) => ({
      id: Number(r.id),
      name: str(r.name),
      quantity: typeof r.quantity === 'number' ? r.quantity : null,
      unitPrice: typeof r.price_unit === 'number' ? r.price_unit : null,
      subtotal: typeof r.price_subtotal === 'number' ? r.price_subtotal : null,
    }))
}

/* ── deep links ─────────────────────────────────────────────────────────────*/

/**
 * Three conditions, all of them, or no link:
 *   the record reference exists;
 *   OdooConfig.url exists — there is no ODOO_BASE_URL anywhere in this repo, so
 *   a base from anywhere else would be fabricated;
 *   the actor may see the object, which the caller establishes before asking.
 *
 * A plausible-looking URL that 404s is worse than no link, because it looks
 * checked.
 */
export function odooDeepLink(
  baseUrl: string | null | undefined,
  model: string,
  recordId: number | null,
): string | null {
  if (!baseUrl || !recordId || !Number.isInteger(recordId) || recordId <= 0) return null
  return `${baseUrl.replace(/\/+$/, '')}/odoo/${encodeURIComponent(model)}/${recordId}`
}

/* ── adapters ───────────────────────────────────────────────────────────────*/

/** Who may see business context at all. Mirrors the workspace manager gate. */
const CONTEXT_ROLES = ['manager', 'owner', 'service_account'] as const

export interface CustomerAdapterDeps {
  call: OdooCaller
  /** From OdooConfig.url. Null when the tenant has no configured instance URL. */
  odooBaseUrl: string | null
  now(): Date
}

function provenance(source: string, now: Date): Provenance {
  return { source, fetchedAt: now, stale: false }
}

/**
 * The sections that have no identified authoritative source.
 *
 * Each one gets a REAL adapter that refuses, rather than being left out of the
 * registry. buildContextBundle only produces sections it has adapters for, so
 * an omission would arrive at the UI as an absent key — indistinguishable from
 * an empty one, which is the exact confusion this whole layer exists to prevent.
 *
 * The reason says only that the source is not connected. No stack trace, no
 * speculation about why, no hint at what the data would have been.
 */
export const UNIDENTIFIED_SECTIONS: readonly BundleSection[] = [
  'services',
  'devices',
  'pbx',
  'notes',
]

/**
 * Calls (dec-c360-design-defines-the-target-find-the-data-2026-09-04): the
 * Lumen reference's "Calls" tab is Magnus CDR data. Magnus lives on
 * voice00/deepseek's own infra, called today only from bff-v2
 * (app/lib/magnus.ts::getMagnusUserCallsEnriched, already built and proven
 * this same week for CDR-side minute metering) -- Foundation itself has no
 * server-to-server path to it, and a customer's magnusUserId is only known
 * for the subset with a Personal Line subscription (LiteAccount), not for a
 * plain Odoo customer. To close this: expose a small bff-v2 read endpoint
 * (e.g. GET /api/internal/customer-360/calls?magnusUserId=) and add a
 * Foundation-side reader that calls it server-to-server, keyed off this
 * partner's magnusUserId if one is on file (LiteAccount.odooPartnerId).
 */
export const CALLS_NOT_CONNECTED_REASON =
  'calls are not connected: Magnus CDR data lives on bff-v2, not Foundation, and no server-to-server read path exists yet'

/**
 * Files (dec-c360-design-defines-the-target-find-the-data-2026-09-04): the
 * reference's "Files" tab is documents attached to the customer record --
 * ir.attachment in Odoo, keyed on res_model='res.partner' AND
 * res_id=customerId (plus, per-invoice/order attachments if the owner wants
 * those included too). No reader for ir.attachment exists anywhere in this
 * repo yet. To close this: one search_read against ir.attachment with those
 * two domain terms, fields id/name/mimetype/file_size/create_date, and the
 * existing odooDeepLink() pattern for a link -- the same shape as every
 * other reader in this file, no new pattern required.
 */
export const FILES_NOT_CONNECTED_REASON =
  'files are not connected: no ir.attachment reader exists yet for this customer record'

export function notConnectedAdapter(section: BundleSection, reason: string): BundleAdapter {
  return {
    section,
    allowedRoles: [...CONTEXT_ROLES],
    async load() {
      // Thrown, not returned: buildContextBundle turns a throw into
      // { status: 'unavailable', reason } and an empty array into `empty`.
      // Returning [] here would be the bug.
      throw new Error(reason)
    },
  }
}

/**
 * project.task is NOT bound, and this is the documented reason.
 *
 * The order required the customer linkage to be proven from source first. It is
 * not there: `partner_id` appears on crm.lead in lookup.ts, lead-create.ts and
 * lead-update.ts, and on no project.task read anywhere. The single existing
 * project.task reader, engines/odoo.ts::findOpenTasksByAssignee, keys on
 * `user_ids.login` and returns id/name/project_id/stage_id/priority/
 * date_deadline — no customer field of any kind. lib/staff-ops/odoo-work.ts
 * says in as many words that project.task carries no tenant dimension of its
 * own, which is why it scopes by assignee instead.
 *
 * The risk of guessing is not an empty section. It is one customer's work shown
 * under another customer's name.
 *
 * To close this: one `ir.model.fields` read against a tenant instance
 * (`domain: [['model','=','project.task'],['name','=','partner_id']]`) settles
 * it, and the adapter is then a copy of readIssues with the model swapped.
 */
export const TASKS_NOT_PROVEN_REASON =
  'tasks are not connected: no customer relationship on project.task has been established for this instance'

export function buildCustomerAdapters(deps: CustomerAdapterDeps): readonly BundleAdapter[] {
  const customerId = (objectId: string) => parseCustomerId(objectId)

  /** Shared shape: refuse an unusable id before it can reach a domain. */
  const reading = <T>(
    section: BundleSection,
    source: string,
    read: (id: number, limit: number) => Promise<T[]>,
  ): BundleAdapter => ({
    section,
    allowedRoles: [...CONTEXT_ROLES],
    async load({ objectId, limit }) {
      const id = customerId(objectId)
      if (id === null) throw new Error('the customer reference is not usable')
      try {
        const data = await read(id, limit)
        return { data, provenance: provenance(source, deps.now()) }
      } catch (err) {
        // Rethrown with SANITISED text. buildContextBundle puts err.message
        // straight into the section's reason, so an unsanitised throw here
        // would put driver text on a screen.
        throw new Error(sanitiseOdooFailure(err))
      }
    },
  })

  return [
    reading('customer', 'odoo:res.partner', (id) => readCustomer(deps.call, id)),
    reading('contacts', 'odoo:res.partner', (id, limit) => readContacts(deps.call, id, limit)),
    reading('opportunities', 'odoo:crm.lead', (id, limit) =>
      readOpportunities(deps.call, id, limit),
    ),
    reading('issues', 'odoo:helpdesk.ticket', (id, limit) => readIssues(deps.call, id, limit)),
    reading('orders', 'odoo:sale.order', (id, limit) => readOrders(deps.call, id, limit)),
    reading('invoices', 'odoo:account.move', (id, limit) => readInvoices(deps.call, id, limit)),

    // Proven-unsafe rather than merely unbuilt. Same shape as the five below so
    // the UI treats it identically, with its own reason.
    notConnectedAdapter('tasks', TASKS_NOT_PROVEN_REASON),
    notConnectedAdapter('calls', CALLS_NOT_CONNECTED_REASON),
    notConnectedAdapter('files', FILES_NOT_CONNECTED_REASON),

    ...UNIDENTIFIED_SECTIONS.map((section) =>
      notConnectedAdapter(section, `${section} is not connected: no authoritative source is configured`),
    ),
  ]
}
