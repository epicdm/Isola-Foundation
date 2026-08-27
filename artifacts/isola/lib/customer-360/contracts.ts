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
  kind: 'opportunity' | 'task';
  state: string | null;
  due: string | null;
  value?: number | null;
}

export interface Customer360Snapshot {
  verifiedAt: string;
  freshness: Freshness;
  conversation: {
    displayId: number;
    currentRequest: string | null;
  };
  customer: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
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

export type Customer360Response =
  | { state: 'ready'; snapshot: Customer360Snapshot }
  | { state: 'not-linked'; message: string }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string };
