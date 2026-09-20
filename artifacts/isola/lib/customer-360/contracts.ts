export type Freshness = 'fresh' | 'stale' | 'unavailable';

export interface Customer360Document {
  id: number;
  reference: string;
  kind: 'quotation' | 'order' | 'invoice';
  state: string | null;
  paymentState?: string | null;
  total: number | null;
  residual?: number | null;
  /**
   * The document's OWN currency, read from Odoo. Never assumed.
   *
   * EPIC's ledger genuinely holds more than one: the unpaid set measured
   * 2026-08-13 was 265 XCD invoices alongside 2 USD ones. Rendering an amount
   * under a currency it was not denominated in produces a confident wrong
   * number, which is the one thing an operator must never read to a customer.
   */
  currency: string | null;
  date: string | null;
  /**
   * The exact record in the authoritative Odoo instance, built server-side
   * from the tenant's resolved OdooConfig.url — never from anything the
   * browser supplies. Null when a link cannot be honestly constructed (no
   * resolved instance URL, or the record id is not a real positive integer).
   */
  odooLink: string | null;
}

/** Outstanding residual for ONE currency. Never combined across currencies. */
export interface Customer360Balance {
  currency: string;
  amount: number;
}

export interface Customer360Loop {
  id: number;
  title: string;
  kind: 'opportunity' | 'task' | 'ticket';
  state: string | null;
  due: string | null;
  value?: number | null;
  /**
   * The exact record in the authoritative Odoo instance, built server-side the
   * same way document links are. Null when it cannot be honestly constructed.
   *
   * Open work previously carried a permanently disabled button whose tooltip
   * promised "the next slice" — a slice that had since shipped. The link uses
   * the identical model-agnostic builder the documents use; only the model name
   * differs.
   */
  odooLink: string | null;
}

/**
 * One real service instance a customer holds. Personal Line is the only
 * `kind` today; the union exists so a second service type is an addition,
 * not a rename. Fields are exactly what bff-v2's own `/customer-360/services`
 * route reports -- LIVE-OBSERVED (registration, Magnus presence), never
 * Portal's own `activation_state` bookkeeping, which that route's own build
 * notes record as sometimes stale. No `odooLink` -- this is not an Odoo
 * record, and no `liteAccountId` -- that join key must never leave bff-v2
 * (the same rule isola-portal's own operator screen enforces on this exact
 * field, doubly, after it leaked once).
 */
export interface Customer360Service {
  kind: 'personal_line';
  /** The real-world identifier this service is keyed on. Also this array's
   *  React key upstream -- stable and never fabricated, unlike a synthetic id. */
  did: string;
  /** `null` when there is no SIP identity to check yet, or the registration
   *  read itself failed -- never a fabricated true/false. */
  sipRegistered: boolean | null;
  /** A Magnus user (and therefore a wallet, even if $0) exists for this
   *  account -- presence only, never a balance signal. See the route's own
   *  naming note: this is deliberately NOT called `hasWallet`. */
  magnusUserAssigned: boolean;
  createdAt: string | null;
}

export interface Customer360Snapshot {
  verifiedAt: string;
  freshness: Freshness;
  conversation: {
    /**
     * NULL when the cockpit was addressed by customer id rather than opened
     * from a conversation — the portal's door. It is not "unknown"; there
     * genuinely is no conversation, and a surface that renders a destination
     * from this must say so rather than invent one.
     */
    displayId: number | null;
    currentRequest: string | null;
  };
  customer: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    /**
     * Odoo's own `res.partner.is_company`. Carried because the composer must
     * not greet an organisation by its first word — "Hi EPIC," for EPIC
     * Communications Inc, "Hi S8-W1," for an account name.
     *
     * This is read from the authority rather than guessed from the string.
     * A name-shape heuristic would be wrong in both directions: it would
     * mangle "Ng" and personalise "Atlas Trading".
     */
    isCompany: boolean;
    /** `res.partner.parent_id`'s name — the organisation this contact sits
     *  under. Null for a company record itself, or a contact with no parent. */
    companyName: string | null;
    /** `res.partner.create_date`. When this record was first created in Odoo —
     *  the closest honest answer to "customer since" this ledger can give. */
    customerSince: string | null;
    /** `res.partner.category_id` names (e.g. Wholesale, VIP). Empty, never
     *  fabricated, when Odoo holds none. */
    tags: string[];
  };
  /**
   * Outstanding residual PER CURRENCY, on posted invoices only.
   *
   * An array rather than a single number because a scalar cannot express a
   * partner who owes in two currencies, and the previous scalar was summed
   * across them and then rendered as XCD. Empty means nothing outstanding;
   * more than one entry means the operator must read them separately.
   */
  balances: Customer360Balance[];
  /**
   * Sum of `amount_total` on this partner's POSTED customer invoices, per
   * currency — never combined across currencies, same reasoning as
   * `balances`. This is a fact about invoices already read for this
   * snapshot, not a second Odoo call: draft invoices are excluded because an
   * unconfirmed document is not revenue.
   */
  lifetimeValue: Customer360Balance[];
  documents: Customer360Document[];
  openLoops: Customer360Loop[];
  /**
   * False when Odoo refused or could not answer the opportunity/task reads.
   *
   * Those two reads are tolerated rather than fatal, because `crm.lead` and
   * `project.task` field availability varies by Odoo edition and module set.
   * But a tolerated failure must not render as "no open work" — that is an
   * outage reported to the operator as a fact about the customer. The UI says
   * "unavailable" when this is false.
   */
  openLoopsAvailable: boolean;
  /**
   * S3: one evidence-backed recommendation, generated only from verified
   * data already in this snapshot. Null whenever no document clearly
   * warrants one (no draft quotation) — recommending nothing is the honest
   * answer, not a missing feature.
   */
  recommendedAction: Customer360RecommendedAction | null;
  /** Real `mail.activity` records on this partner. Tolerated failure, same
   *  shape as openLoopsAvailable — see followUpsAvailable. */
  followUps: Customer360FollowUp[];
  followUpsAvailable: boolean;
  /**
   * Real service instances this customer holds -- Personal Line is the
   * first kind (dec-customer-workspace-services-tab-and-6-tab-mapping-
   * 2026-09-20). Lives on bff-v2, not Foundation, keyed on
   * LiteAccount.odooPartnerId (ev-agent-lane-customer-liteaccount-linkage-
   * source-proven-2026-09-20) -- same cross-system-boundary shape as calls,
   * and the same tolerated-failure discipline as openLoops/followUps: a
   * bff-v2 outage must render as unavailable, never as "no services".
   */
  services: Customer360Service[];
  servicesAvailable: boolean;
  /**
   * Messages, orders and invoices already read for this snapshot, merged
   * into one chronological stream — no second Odoo/Chatwoot call. Calls are
   * DELIBERATELY absent: Magnus CDR data lives on bff-v2, not Foundation,
   * and no server-to-server read path exists yet (same fact
   * lib/context/customer-sources.ts's CALLS_NOT_CONNECTED_REASON already
   * documents for the sibling lineage) — omitted, never faked as a call
   * that did not happen.
   */
  timeline: Customer360TimelineEntry[];
  /** Named so the surface can say WHY calls are missing, not just that they
   *  are — the same honesty this file's other "not connected" reasons use. */
  timelineCallsNote: string;
}

/** One `mail.activity` on the partner — a real Odoo follow-up, not a
 *  second store. */
export interface Customer360FollowUp {
  id: number;
  summary: string;
  dueDate: string | null;
  /** "Today" / "Tomorrow" when the real date matches, else the ISO date
   *  itself — never a vague "soon". Computed once, server-side, at the
   *  same moment `verifiedAt` is set. */
  dueLabel: string;
  assignee: string | null;
}

/** One entry in the merged timeline. `kind` decides which optional fields
 *  are populated — a message never carries `total`, an invoice never
 *  carries `text`. */
export interface Customer360TimelineEntry {
  kind: 'message' | 'order' | 'invoice';
  id: string;
  date: string;
  /** Who sent it, for a message only: the customer, or Isola/the operator. */
  from?: 'customer' | 'operator';
  text?: string;
  reference?: string;
  total?: number | null;
  currency?: string | null;
  status?: string | null;
}

export interface Customer360RecommendedAction {
  kind: 'review-draft-quotation';
  /** Compact one-line recommendation, e.g. "Review quotation S00670 and ask
   *  the customer whether they would like to proceed or request changes." */
  headline: string;
  /** The quotation this recommendation is about — always present, always verified. */
  document: Customer360Document;
  /** Plain-language reasoning shown beside the recommendation, not just the verdict. */
  reasoning: string;
  /**
   * A reply an operator can review, edit and send themselves. Generated only
   * from verified customer/document/amount/currency fields already in this
   * snapshot — never claims the document was sent, attached or accepted.
   */
  suggestedReply: string;
}

/* ── the nested object workspace ──────────────────────────────────────────── */

/**
 * Why a THREE-state value and not a boolean or an empty array.
 *
 * "Nothing to show" has three causes that look identical on screen and mean
 * entirely different things to an operator deciding whether to trust it:
 *
 *   available     — the read worked. An empty list genuinely means none exist.
 *   unavailable   — the read FAILED. We know nothing. Never render as "none".
 *   not-supported — the model is not installed in this Odoo (404).
 *   not-permitted — the model EXISTS and this account may not read it (403).
 *
 * The last two are the ones that get collapsed, and the difference is the
 * difference between "we cannot have this" and "someone can grant this".
 *
 * MEASURED 2026-08-29, and the two instances disagree completely:
 *   isola_erp (staging)  — crm.lead, helpdesk.ticket, stock.picking all 404.
 *   EPIC production      — helpdesk.ticket 200 (1,439 rows), stock.picking 200
 *                          (62), project.task 200 (2,317); crm.lead **403**.
 *
 * So a 404 was a statement about STAGING, never about Odoo — and production's
 * crm.lead is an ACL grant away, not a missing capability. CLAUDE.md is explicit
 * that a permission must never be inferred from an error code; reporting a 403
 * as "unavailable" would bury a fixable grant behind a data-shaped excuse.
 */
export type DetailAvailability =
  | 'available'
  | 'unavailable'
  | 'not-supported'
  | 'not-permitted';

/** One line on an order or invoice, as Odoo holds it. Never recomputed here. */
export interface Customer360ObjectLine {
  id: number;
  label: string;
  quantity: number | null;
  unitPrice: number | null;
  /** Odoo's own subtotal. We do not multiply qty × price ourselves: taxes,
   *  discounts and rounding are the ledger's business, not this panel's. */
  subtotal: number | null;
}

/** A payment recorded against an invoice. */
export interface Customer360ObjectPayment {
  id: number;
  amount: number | null;
  currency: string | null;
  date: string | null;
  reference: string | null;
}

/**
 * One step on the object's stage rail.
 *
 * Every stage is DERIVED from a real Odoo field. The reference design shows an
 * order rail of Deal→Order→Fulfilled→Invoiced→Paid, but "Fulfilled" needs
 * `stock.picking`, which is not installed — so that rail would carry a step
 * nothing can justify. We render the stages we can derive and no others.
 */
export interface Customer360Stage {
  key: string;
  label: string;
  state: 'done' | 'current' | 'upcoming';
}

/**
 * One object opened INSIDE the customer workspace.
 *
 * The customer stays the container; this is what the surface becomes when an
 * operator opens a specific order or invoice from a row. Availability is
 * per-section, because the lines read and the payments read can fail
 * independently and a panel that showed "no payments" for a failed read would
 * be asserting something about money it never established.
 */
export interface Customer360ObjectDetail {
  kind: 'quotation' | 'order' | 'invoice' | 'ticket';
  id: number;
  reference: string;
  state: string | null;
  paymentState: string | null;
  total: number | null;
  currency: string | null;
  date: string | null;
  dueDate: string | null;
  odooLink: string | null;
  stages: Customer360Stage[];
  lines: Customer360ObjectLine[];
  linesAvailability: DetailAvailability;
  payments: Customer360ObjectPayment[];
  paymentsAvailability: DetailAvailability;
  /**
   * Ticket-only, real `helpdesk.ticket` fields. Undefined for every other
   * kind — never populated with an invented value for a kind that has no
   * such field.
   */
  priority?: string | null;
  assignee?: string | null;
  updatedAt?: string | null;
}

export type Customer360ObjectResponse =
  | { state: 'ready'; detail: Customer360ObjectDetail }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string };

export type Customer360Response =
  | { state: 'ready'; snapshot: Customer360Snapshot }
  | { state: 'not-linked'; message: string }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string };
