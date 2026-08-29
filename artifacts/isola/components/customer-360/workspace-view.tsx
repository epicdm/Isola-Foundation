/**
 * CustomerWorkspaceView — the Customer 360 cockpit, as a PURE view.
 *
 * WHAT "PURE" MEANS HERE, AND WHY IT IS THE WHOLE POINT
 * ----------------------------------------------------
 * No data fetching. No router. No Chatwoot. No `next/*`. No `'use client'` —
 * the CONTAINER owns that boundary. Everything this view does with the outside
 * world arrives as a prop and leaves as a callback.
 *
 * This exists because the cockpit must render in two places from one
 * implementation: embedded in a Chatwoot conversation, and mounted at the
 * portal's Customers route. Until now it could only ever be the former — it
 * learned who it was looking at by listening for a Chatwoot `postMessage`, so
 * mounted anywhere else it would have waited forever for a message nobody was
 * going to send.
 *
 * The rule that keeps it honest: if a change would make this file import a
 * framework, reach for a router, or open a socket, it belongs in a container.
 *
 * ON `domain`
 * -----------
 * A tenant's industry rotates terminology — Customers become Patients or
 * Clients, ticket ids take a CAS or JOB prefix. That engine is a SHARED
 * PLATFORM LAYER owned by the Lumen lane
 * (dec-domain-vertical-engine-is-shared-platform-layer-c360-consumes-2026-08-29);
 * this cockpit CONSUMES it and never grows vertical logic of its own.
 *
 * It takes the RESOLVED value, not a resolver. A value is inert and trivially
 * testable; a resolver is a capability this view could then invoke at arbitrary
 * times, which is exactly the kind of reach a pure view must not have. Absent
 * or unknown resolves to the generic labels below — never a guessed vertical.
 */

import { useState } from 'react';

import type {
  Customer360ObjectDetail,
  Customer360Snapshot,
  Customer360Stage,
  DetailAvailability,
} from '@/lib/customer-360/contracts';
import { sendBadgeText, type SendOutcome } from '@/lib/customer-360/send-badge';
import styles from './customer-360.module.css';

/* ── the shape the shared domain engine resolves to ────────────────────────
   Structural, and deliberately minimal: this is the contract we consume, not
   one we define. When the Lumen lane publishes `IsolaDomain` somewhere both
   repos can reach, this alias is replaced by the import and nothing else in
   this file changes. */
export interface WorkspaceDomain {
  /** Per-tab label overrides, keyed by tab id. Missing key → base label. */
  nav?: Partial<Record<string, string>>;
  /** Entity nouns, e.g. { Cap: 'Patient', lower: 'patient' }. */
  entity?: { Cap?: string; lower?: string };
}

/** Base labels. Every tenant-facing string in this view resolves through here. */
const BASE_LABELS: Record<string, string> = {
  overview: 'Overview',
  sales: 'Sales',
  billing: 'Billing',
  support: 'Support',
};

export type WorkspaceTab = 'overview' | 'sales' | 'billing' | 'support';

/** One object opened inside the customer. Null when the customer is the view. */
export type NestedTarget = {
  kind: 'quotation' | 'order' | 'invoice';
  id: number;
  reference: string;
};

export type NestedPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: Customer360ObjectDetail }
  | { kind: 'message'; text: string };

export type SendPhase =
  | { kind: 'previewing' }
  | { kind: 'reviewing'; body: string; fingerprint: string }
  | { kind: 'sending'; body: string }
  | { kind: 'settled'; outcome: SendOutcome }
  | { kind: 'refused'; detail: string };

export type NavTarget =
  | { to: 'customer'; customerId: number }
  | { to: 'object'; kind: NestedTarget['kind']; id: number };

type Document = Customer360Snapshot['documents'][number];

export interface WorkspaceViewProps {
  snapshot: Customer360Snapshot;

  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;

  /** An object opened inside the customer, with the container's fetch state. */
  nested: { target: NestedTarget; phase: NestedPhase } | null;
  onOpenObject: (target: NestedTarget) => void;
  onCloseObject: () => void;

  /**
   * The outcome of a previous send for one document, if any.
   *
   * A function rather than a map, because the KEY is a container concern: the
   * Chatwoot container keys by conversation so a badge cannot land on a sibling
   * row, and a portal container may key differently. The view must not know.
   */
  outcomeFor: (doc: Document) => SendOutcome | undefined;

  /** The send dialog, driven entirely by the container. */
  send: { doc: Document; phase: SendPhase } | null;
  onSendOpen: (doc: Document) => void;
  onSendConfirm: (body: string, fingerprint: string) => void;
  onSendClose: () => void;

  /** The prepare-reply dialog. Local text editing only — no network. */
  replyOpen: boolean;
  onReplyOpen: () => void;
  onReplyClose: () => void;

  /**
   * Where the message would be posted, for display only. The view never
   * resolves this and never sends it anywhere — the container owns the locator.
   */
  destinationLabel: string | null;

  domain?: WorkspaceDomain;
  onNavigate?: (target: NavTarget) => void;
}

function label(domain: WorkspaceDomain | undefined, id: string): string {
  return domain?.nav?.[id] ?? BASE_LABELS[id] ?? id;
}

/**
 * Format an amount in ITS OWN currency.
 *
 * The previous single formatter hardcoded XCD and was applied to every figure,
 * so a USD invoice rendered as EC$. A wrong number wearing a confident currency
 * symbol is the failure mode this workspace exists to prevent: an operator can
 * read it straight to a customer. When Odoo did not give us a currency we show
 * the bare amount and say so, rather than guessing one.
 */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null) return '—';
  if (!currency) return `${amount.toLocaleString('en-DM')} (currency unknown)`;
  try {
    return new Intl.NumberFormat('en-DM', { style: 'currency', currency }).format(amount);
  } catch {
    // An unrecognised ISO code must not throw the whole panel away.
    return `${amount.toLocaleString('en-DM')} ${currency}`;
  }
}

/** Balances are never combined; each currency is its own line. */
function formatBalances(balances: Customer360Snapshot['balances']): string {
  if (!balances.length) return 'No posted balance';
  return balances.map((b) => formatMoney(b.amount, b.currency)).join(' + ');
}

/**
 * A document is offerable for sending only when the server could actually
 * compose a message for it: a sendable kind, a verified total and a verified
 * currency. Offering a button whose only possible outcome is a refusal is worse
 * than not offering it.
 */
export function sendability(item: Document): { ok: true } | { ok: false; why: string } {
  if (item.kind !== 'quotation' && item.kind !== 'invoice') {
    return { ok: false, why: 'Only quotations and invoices can be sent to a customer.' };
  }
  // A draft invoice is not a debt. It stays VISIBLE — an operator wants to know
  // it exists — but it is not sendable, because the message would demand payment
  // for a document Odoo has not posted, under Odoo's placeholder reference '/'.
  // The server refuses this independently; the button is disabled so we never
  // offer an action whose only possible outcome is a refusal.
  if (item.kind === 'invoice' && (item.state ?? '').trim() !== 'posted') {
    return { ok: false, why: 'This invoice is still a draft in Odoo, so it cannot be sent to a customer. Post it in Odoo first.' };
  }
  if (item.total == null) return { ok: false, why: 'This record has no verified total, so it cannot be sent.' };
  if (!item.currency) return { ok: false, why: 'This record has no verified currency, so it cannot be sent.' };
  return { ok: true };
}

/**
 * The state a record is in, as a semantic chip.
 *
 * Colour is a second channel, never the only one — the word itself is the
 * label, so meaning survives monochrome and a screen reader. Anything
 * unrecognised renders neutral rather than being dressed in a colour we cannot
 * justify.
 */
export function stateChip(item: Document): { label: string; tone: string } {
  const payment = (item.paymentState ?? '').trim();
  const state = (item.state ?? '').trim();

  if (item.kind === 'invoice') {
    if (state && state !== 'posted') return { label: state === 'draft' ? 'Draft' : state, tone: styles.state };
    if (payment === 'paid') return { label: 'Paid', tone: `${styles.state} ${styles.stateOk}` };
    if (payment === 'partial') return { label: 'Part paid', tone: `${styles.state} ${styles.stateWarn}` };
    if (payment === 'not_paid') return { label: 'Unpaid', tone: `${styles.state} ${styles.stateDanger}` };
  }
  if (!state) return { label: 'State unavailable', tone: styles.state };
  if (state === 'draft') return { label: 'Draft', tone: styles.state };
  if (state === 'sent') return { label: 'Sent', tone: `${styles.state} ${styles.stateWarn}` };
  if (state === 'sale' || state === 'done') return { label: 'Confirmed', tone: `${styles.state} ${styles.stateOk}` };
  if (state === 'cancel') return { label: 'Cancelled', tone: styles.state };
  return { label: state, tone: styles.state };
}

/**
 * The stage rail. Every step is derived from a real Odoo field. A rail with a
 * step nothing can justify would be decoration wearing the appearance of state.
 */
function StageRail({ stages }: { stages: Customer360Stage[] }) {
  if (!stages.length) return null;
  return <ol className={styles.stageRail} aria-label="Progress">
    {stages.map((s) => (
      <li key={s.key} className={`${styles.stage} ${s.state === 'done' ? styles.stageDone : s.state === 'current' ? styles.stageCurrent : ''}`}>
        <span className={styles.stageDot} aria-hidden="true">{s.state === 'done' ? '✓' : ''}</span>
        <span>{s.label}</span>
      </li>
    ))}
  </ol>;
}

/**
 * A section that could not be read says so, and says WHICH KIND of could-not.
 *
 * Four states, because "nothing to show" has four causes that mean entirely
 * different things — and two of them are actionable by a person: a missing
 * module can be installed, a refused read can be granted. Collapsing them into
 * "no data" hides both.
 */
function SectionState({ availability, empty }: { availability: DetailAvailability; empty: string }) {
  if (availability === 'available') {
    return <div className={styles.empty}><p>{empty}</p></div>;
  }
  const text =
    availability === 'not-supported'
      ? 'This Odoo does not have that feature installed, so there is nothing to read.'
      : availability === 'not-permitted'
        ? 'Isola is not permitted to read this in Odoo. That is a permission that can be granted — it is not a missing feature.'
        : 'Odoo did not answer for this. This is not a statement that there is none.';
  return <div className={styles.unavailable}>{text}</div>;
}

/** One evidence-backed recommendation, shown only when the server produced one. */
export function RecommendedActionCard({ snapshot, onPrepareReply }: {
  snapshot: Customer360Snapshot;
  onPrepareReply: () => void;
}) {
  const action = snapshot.recommendedAction;
  if (!action) return null;

  return (
    <section className={styles.recommendation}>
      <div className={styles.sectionHead}>
        <div><span className={styles.eyebrow}>Recommended action</span><h2>{action.headline}</h2></div>
      </div>
      <dl className={styles.reviewFacts}>
        <div><dt>Document</dt><dd>{action.document.reference}</dd></div>
        <div><dt>State</dt><dd>{action.document.state ?? 'unavailable'}</dd></div>
        <div><dt>Amount</dt><dd>{formatMoney(action.document.total, action.document.currency)}</dd></div>
        <div><dt>Odoo as of</dt><dd>{new Date(snapshot.verifiedAt).toLocaleTimeString()}</dd></div>
      </dl>
      <p className={styles.reasoning}>{action.reasoning}</p>
      <div className={styles.reviewActions}>
        {action.document.odooLink
          ? <a className={styles.secondaryBtn} href={action.document.odooLink} target="_blank" rel="noopener noreferrer">Open quotation in Odoo</a>
          : <button className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open quotation in Odoo</button>}
        <button className={styles.primaryBtn} onClick={onPrepareReply}>Prepare reply</button>
      </div>
    </section>
  );
}

/** Review, edit and copy a suggested reply. Local text only — no network. */
export function ReplyReview({ snapshot, onClose }: {
  snapshot: Customer360Snapshot;
  onClose: () => void;
}) {
  const action = snapshot.recommendedAction;
  const [draft, setDraft] = useState(action?.suggestedReply ?? '');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (!action) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Review suggested reply">
      <section className={styles.reviewCard}>
        <h2>Review before you use this</h2>
        <dl className={styles.reviewFacts}>
          <div><dt>Customer</dt><dd>{snapshot.customer.name}</dd></div>
          <div><dt>Quotation</dt><dd>{action.document.reference} · {action.document.state ?? 'state unavailable'}</dd></div>
          <div><dt>Amount</dt><dd>{formatMoney(action.document.total, action.document.currency)}</dd></div>
        </dl>

        <label className={styles.replyLabel} htmlFor="c360-reply-draft">Proposed reply — edit freely</label>
        <textarea
          id="c360-reply-draft"
          className={styles.replyBox}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setCopyState('idle'); }}
          rows={5}
        />

        <p className={styles.effectNote}>
          This will place text on your clipboard. It will not send a message or change Odoo.
        </p>

        <div className={styles.reviewActions}>
          <button className={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.primaryBtn}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft);
                setCopyState('copied');
              } catch {
                // Measured: a Chatwoot Dashboard App iframe carries no
                // allow="clipboard-write", so the Clipboard API is denied by the
                // browser's default Permissions Policy for cross-origin frames.
                setCopyState('failed');
              }
            }}
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Could not copy — select the text and press Ctrl/Cmd+C' : 'Copy suggested reply'}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Review and confirm one document send.
 *
 * PURE. The container performs the preview and the send; this renders whichever
 * phase it is given and emits the confirm. There is deliberately no textarea —
 * an editable body would make the panel the author of a customer-facing price,
 * which is exactly what the server-side composer exists to prevent.
 */
function SendReview({ doc, phase, destinationLabel, onConfirm, onClose }: {
  doc: Document;
  phase: SendPhase;
  destinationLabel: string | null;
  onConfirm: (body: string, fingerprint: string) => void;
  onClose: () => void;
}) {
  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Send ${doc.reference} to the customer`}>
    <section className={styles.reviewCard}>
      <span className={styles.eyebrow}>Send to customer</span>
      <h2>{doc.reference}</h2>

      <dl className={styles.reviewFacts}>
        <div><dt>Document</dt><dd>{doc.kind} {doc.reference}</dd></div>
        <div><dt>Amount</dt><dd>{formatMoney(doc.total, doc.currency)}</dd></div>
        {destinationLabel && <div><dt>Destination</dt><dd>{destinationLabel}</dd></div>}
        <div><dt>Delivered by</dt><dd>The channel that owns this conversation</dd></div>
      </dl>

      {phase.kind === 'previewing' && <p className={styles.copyHint}>Preparing the message from the Odoo record…</p>}
      {phase.kind === 'refused' && <p className={styles.effectNote}>{phase.detail}</p>}

      {(phase.kind === 'reviewing' || phase.kind === 'sending') && <>
        <span className={styles.replyLabel}>This exact message will be sent to the customer</span>
        <pre className={styles.replyBox}>{phase.body}</pre>
        <p className={styles.effectNote}>
          Sending posts this as a visible reply{destinationLabel ? ` in ${destinationLabel}` : ''}. It does not change
          anything in Odoo, and it cannot be unsent.
        </p>
        <p className={styles.effectNote}>
          <strong>This also moves the conversation to you.</strong> The AI assistant stops replying once you send, so
          the customer’s next message is yours to answer.
        </p>
      </>}

      {phase.kind === 'settled' && <>
        <p className={phase.outcome.success ? styles.copyHint : styles.effectNote}>
          <strong>{sendBadgeText(phase.outcome)}</strong>
          {phase.outcome.detail ? <> — {phase.outcome.detail}</> : null}
          {phase.outcome.operationId && <><br /><small>Reference {phase.outcome.operationId}</small></>}
        </p>

        {/* A REPLAY SHOWS THE MESSAGE, IT DOES NOT ASSERT IT. */}
        {phase.outcome.priorReadback?.content && <>
          <span className={styles.replyLabel}>
            What the customer already received
            {phase.outcome.priorReadback.at ? ` — ${new Date(phase.outcome.priorReadback.at).toLocaleString()}` : ''}
          </span>
          <pre className={styles.replyBox}>{phase.outcome.priorReadback.content}</pre>
          <p className={styles.copyHint}>
            Read back from the conversation, not re-composed here. Nothing was sent again.
          </p>
        </>}
      </>}

      <div className={styles.reviewActions}>
        {phase.kind === 'reviewing' && <button className={styles.primaryBtn} onClick={() => onConfirm(phase.body, phase.fingerprint)}>
          Confirm and send to the customer
        </button>}
        {phase.kind === 'sending' && <button className={styles.primaryBtn} disabled>Sending…</button>}
        <button className={styles.secondaryBtn} onClick={onClose}>
          {phase.kind === 'settled' ? 'Close' : 'Cancel'}
        </button>
      </div>
    </section>
  </div>;
}

function NestedObject({ target, phase, onBack }: {
  target: NestedTarget;
  phase: NestedPhase;
  onBack: () => void;
}) {
  const [sub, setSub] = useState<'overview' | 'lines' | 'payments'>('overview');
  const isInvoice = target.kind === 'invoice';

  return <section className={styles.card}>
    {/* Breadcrumb: you never left the customer — this opened inside it. */}
    <div className={styles.breadcrumb}>
      <button type="button" className={styles.crumbLink} onClick={onBack}>Customer</button>
      <span aria-hidden="true">›</span>
      <span className={styles.crumbCurrent}>{target.reference}</span>
    </div>

    {phase.kind === 'loading' && <div className={styles.empty}><p>Reading {target.reference} from Odoo…</p></div>}
    {phase.kind === 'message' && <div className={styles.unavailable}>{phase.text}</div>}

    {phase.kind === 'ready' && <>
      <div className={styles.objectHead}>
        <div className={styles.identityBody}>
          <h2 className={styles.identityTitle}>{phase.detail.reference}</h2>
          <p className={styles.identityMeta}>
            <span>{phase.detail.kind}</span>
            {phase.detail.dueDate && <><span>·</span><span>due {phase.detail.dueDate}</span></>}
          </p>
        </div>
        <span className={`${styles.rowAmount} ${styles.tnum}`}>
          {formatMoney(phase.detail.total, phase.detail.currency)}
        </span>
        {phase.detail.odooLink
          ? <a className={styles.secondaryBtn} href={phase.detail.odooLink} target="_blank" rel="noopener noreferrer">Open in Odoo</a>
          : <button type="button" className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open in Odoo</button>}
      </div>

      <StageRail stages={phase.detail.stages} />

      <nav className={styles.subTabs} aria-label={`${phase.detail.reference} sections`}>
        {([['overview', 'Overview'], ['lines', 'Lines'], ...(isInvoice ? [['payments', 'Payments'] as const] : [])] as const).map(([id, lbl]) => (
          <button
            key={id}
            type="button"
            className={`${styles.subTab} ${sub === id ? styles.subTabOn : ''}`}
            aria-current={sub === id ? 'true' : undefined}
            onClick={() => setSub(id)}
          >{lbl}</button>
        ))}
      </nav>

      {sub === 'overview' && <dl className={styles.reviewFacts}>
        <div><dt>State</dt><dd>{phase.detail.state ?? 'unavailable'}</dd></div>
        {isInvoice && <div><dt>Payment</dt><dd>{phase.detail.paymentState ?? 'unavailable'}</dd></div>}
        <div><dt>Dated</dt><dd>{phase.detail.date ?? '—'}</dd></div>
        <div><dt>Total</dt><dd className={styles.tnum}>{formatMoney(phase.detail.total, phase.detail.currency)}</dd></div>
      </dl>}

      {sub === 'lines' && (phase.detail.lines.length
        ? phase.detail.lines.map((l) => <article className={styles.row} key={l.id}>
            <div className={styles.rowBody}>
              <div className={styles.rowRef}>{l.label}</div>
              <p className={styles.rowMeta}>
                <span className={styles.tnum}>{l.quantity ?? '—'}</span>
                <span>×</span>
                <span className={styles.tnum}>{formatMoney(l.unitPrice, phase.detail.currency)}</span>
              </p>
            </div>
            {/* Odoo's own subtotal, never qty × price recomputed here. */}
            <span className={`${styles.rowAmount} ${styles.tnum}`}>{formatMoney(l.subtotal, phase.detail.currency)}</span>
          </article>)
        : <SectionState availability={phase.detail.linesAvailability} empty="Odoo answered, and this record has no lines." />)}

      {sub === 'payments' && (phase.detail.payments.length
        ? phase.detail.payments.map((p) => <article className={styles.row} key={p.id}>
            <div className={styles.rowBody}>
              <div className={styles.rowRef}>{p.reference ?? 'Payment'}</div>
              <p className={styles.rowMeta}><span>{p.date ?? 'No date'}</span></p>
            </div>
            <span className={`${styles.rowAmount} ${styles.tnum}`}>{formatMoney(p.amount, p.currency)}</span>
          </article>)
        : <SectionState availability={phase.detail.paymentsAvailability} empty="Odoo answered, and no payments are recorded against this invoice." />)}
    </>}
  </section>;
}

function DocumentList({ title, note, empty, items, outcomeFor, onSend, onOpen }: {
  title: string;
  note: string;
  empty: string;
  items: Customer360Snapshot['documents'];
  outcomeFor: (doc: Document) => SendOutcome | undefined;
  onSend: (item: Document) => void;
  onOpen: (target: NestedTarget) => void;
}) {
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Odoo records</span><h2>{title}</h2></div>
      <p>{note}</p>
    </div>
    {items.length ? items.map((item) => {
      const can = sendability(item);
      const outcome = outcomeFor(item);
      const chip = stateChip(item);
      return <article className={styles.row} key={`${item.kind}-${item.id}`}>
        <div className={styles.rowBody}>
          {/* The reference opens the object INSIDE the customer. Not a link —
              nothing navigates; the workspace becomes this object's workspace. */}
          <button type="button" className={styles.rowOpen} onClick={() => onOpen({ kind: item.kind, id: item.id, reference: item.reference })}>
            {item.reference}
          </button>
          <p className={styles.rowMeta}>
            <span className={chip.tone}>{chip.label}</span>
            <span>{item.kind}</span>
            {/* Only a proven readback prints as posted. Anything else says what it was. */}
            {outcome && <><span>·</span><span>{sendBadgeText(outcome)}</span></>}
          </p>
        </div>
        <span className={`${styles.rowAmount} ${styles.tnum}`}>{formatMoney(item.total, item.currency)}</span>
        <div className={styles.rowActions}>
          {item.odooLink
            ? <a className={styles.secondaryBtn} href={item.odooLink} target="_blank" rel="noopener noreferrer">Open in Odoo</a>
            : <button type="button" className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open in Odoo</button>}
          {can.ok
            ? <button type="button" className={styles.primaryBtn} onClick={() => onSend(item)}>Send to customer</button>
            : <button type="button" className={styles.btn} disabled title={can.why}>Send to customer</button>}
        </div>
      </article>;
    }) : <div className={styles.empty}>
      <p className={styles.emptyTitle}>Nothing here</p>
      <p>{empty}</p>
    </div>}
  </section>;
}

export function CustomerWorkspaceView(props: WorkspaceViewProps) {
  const {
    snapshot, tab, onTabChange, nested, onOpenObject, onCloseObject,
    outcomeFor, send, onSendOpen, onSendConfirm, onSendClose,
    replyOpen, onReplyOpen, onReplyClose, destinationLabel, domain,
  } = props;

  /**
   * ONE PREDICATE PER TAB, NAMED ONCE, USED FOR BOTH THE COUNT AND THE ROWS.
   *
   * The count on a tab and the list under it must be the same set. Previously
   * the overview counted `kind === 'quotation'` while the Sales tab listed
   * `kind !== 'invoice'`, so a customer with two quotations and three orders
   * saw "2" above five rows. The design pack this styling comes from has the
   * identical defect, so it could not be copied — only fixed.
   */
  const salesDocs = snapshot.documents.filter((d) => d.kind !== 'invoice');
  const invoiceDocs = snapshot.documents.filter((d) => d.kind === 'invoice');
  const loops = snapshot.openLoops;

  /** Undefined renders no badge at all. A "0" chip is noise; its absence says the same thing. */
  const counts: Partial<Record<WorkspaceTab, number>> = {
    sales: salesDocs.length || undefined,
    billing: invoiceDocs.length || undefined,
    // Only a successful read may produce a count. When Odoo did not answer we
    // show no badge rather than a zero that would read as "none exist".
    support: snapshot.openLoopsAvailable ? loops.length || undefined : undefined,
  };

  const TABS: WorkspaceTab[] = ['overview', 'sales', 'billing', 'support'];

  const checkedAt = new Date(snapshot.verifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const freshnessClass =
    snapshot.freshness === 'unavailable' ? styles.freshnessUnavailable
      : snapshot.freshness === 'stale' ? styles.freshnessStale
        : undefined;
  const freshnessText =
    snapshot.freshness === 'unavailable' ? 'Odoo did not answer — this may be out of date'
      : snapshot.freshness === 'stale' ? `Last confirmed ${checkedAt} — may be out of date`
        : `Read from Odoo at ${checkedAt}`;

  return <main className={styles.shell}>
    <header className={styles.identityBar}>
      <div className={styles.identityBody}>
        <h1 className={styles.identityTitle}>{snapshot.customer.name}</h1>
        <p className={styles.identityMeta}>
          <span>{snapshot.customer.phone ?? 'No phone'}</span>
          <span>·</span>
          <span>{snapshot.customer.email ?? 'No email'}</span>
        </p>
      </div>
      <span className={styles.verifiedChip}>Verified Odoo customer</span>
      <div className={styles.balanceBlock}>
        <span className={styles.balanceLabel}>Balance due</span>
        <strong className={`${styles.balanceValue} ${styles.tnum}`}>{formatBalances(snapshot.balances)}</strong>
        <small className={`${styles.balanceNote} ${freshnessClass ?? ''}`}>
          {snapshot.balances.length > 1 ? 'Separate currencies — not combined' : freshnessText}
        </small>
      </div>
    </header>

    {/*
      ONE recommendation surface, server-derived and evidence-gated. The
      browser-side "Suggested next step" that used to sit beside it is gone: it
      emitted a sentence unconditionally and its overdue test read an absent
      residual as "not overdue", which is an unanswered read rendered as a fact
      about money. Silence is the honest answer when nothing warrants one.
    */}
    <RecommendedActionCard snapshot={snapshot} onPrepareReply={onReplyOpen} />
    {replyOpen && <ReplyReview snapshot={snapshot} onClose={onReplyClose} />}
    {send && <SendReview
      doc={send.doc}
      phase={send.phase}
      destinationLabel={destinationLabel}
      onConfirm={onSendConfirm}
      onClose={onSendClose}
    />}

    <nav className={styles.tabs} aria-label="Customer workspace">
      {TABS.map((id) => (
        <button
          key={id}
          type="button"
          className={`${styles.tab} ${tab === id ? styles.activeTab : ''}`}
          aria-current={tab === id ? 'page' : undefined}
          // Switching tab returns to the customer level. An object opened under
          // Billing must not still be showing when the operator moves to Sales.
          onClick={() => { onCloseObject(); onTabChange(id); }}
        >
          {label(domain, id)}
          {counts[id] !== undefined && <span className={styles.tabCount}>{counts[id]}</span>}
        </button>
      ))}
    </nav>

    <div className={styles.body}>
      {/*
        The nested object REPLACES the tab body, not the page. The identity bar,
        the tab row and the dialogs all stay mounted above it — the customer is
        still the container; an order or invoice simply opened inside it.
      */}
      {nested && <NestedObject target={nested.target} phase={nested.phase} onBack={onCloseObject} />}

      {!nested && tab === 'overview' && <section className={styles.grid}>
        <article className={`${styles.card} ${styles.tile}`}>
          <span className={styles.eyebrow}>{label(domain, 'sales')}</span>
          <strong className={`${styles.tileValue} ${styles.tnum}`}>{salesDocs.length}</strong>
          <p className={styles.tileNote}>{salesDocs.length === 1 ? 'quotation or order' : 'quotations and orders'}</p>
          <button type="button" className={styles.tileLink} onClick={() => onTabChange('sales')}>Review sales →</button>
        </article>
        <article className={`${styles.card} ${styles.tile}`}>
          <span className={styles.eyebrow}>{label(domain, 'billing')}</span>
          <strong className={`${styles.tileValue} ${styles.tnum}`}>{invoiceDocs.length}</strong>
          <p className={styles.tileNote}>{invoiceDocs.length === 1 ? 'invoice' : 'invoices'} · Odoo remains the record</p>
          <button type="button" className={styles.tileLink} onClick={() => onTabChange('billing')}>Review billing →</button>
        </article>
        <article className={`${styles.card} ${styles.tile}`}>
          <span className={styles.eyebrow}>Open work</span>
          <strong className={`${styles.tileValue} ${snapshot.openLoopsAvailable ? styles.tnum : ''}`}>
            {snapshot.openLoopsAvailable ? loops.length : 'Unavailable'}
          </strong>
          <p className={styles.tileNote}>
            {snapshot.openLoopsAvailable
              ? (loops[0]?.title ?? 'Nothing open in Odoo')
              : 'Odoo did not answer. This is not a statement that none exist.'}
          </p>
          <button type="button" className={styles.tileLink} onClick={() => onTabChange('support')}>Review open work →</button>
        </article>
      </section>}

      {!nested && tab === 'sales' && <DocumentList
        title="Quotations and orders"
        note="Review the source record before sending anything."
        empty="Odoo answered, and this customer has no quotations or orders."
        items={salesDocs} outcomeFor={outcomeFor} onSend={onSendOpen} onOpen={onOpenObject} />}

      {!nested && tab === 'billing' && <DocumentList
        title="Invoices"
        note="Only a posted invoice can be sent to a customer."
        empty="Odoo answered, and this customer has no invoices."
        items={invoiceDocs} outcomeFor={outcomeFor} onSend={onSendOpen} onOpen={onOpenObject} />}

      {!nested && tab === 'support' && <section className={styles.card}>
        <div className={styles.sectionHead}>
          <div><span className={styles.eyebrow}>Close the loop</span><h2>Open customer work</h2></div>
          <p>Review before creating a duplicate.</p>
        </div>
        {!snapshot.openLoopsAvailable
          ? <div className={styles.unavailable}>
              <strong>Odoo did not answer for opportunities or tasks.</strong>
              This is not a statement that there is none. Open the customer in Odoo before
              assuming there is no open work.
            </div>
          : loops.length
            ? loops.map((loop) => <article className={styles.row} key={`${loop.kind}-${loop.id}`}>
                <div className={styles.rowBody}>
                  <div className={styles.rowRef}>{loop.title}</div>
                  <p className={styles.rowMeta}>
                    <span className={styles.state}>{loop.kind}</span>
                    <span>{loop.state ?? 'State unavailable'}</span>
                    <span>·</span>
                    <span>{loop.due ?? 'No due date'}</span>
                  </p>
                </div>
                <div className={styles.rowActions}>
                  {loop.odooLink
                    ? <a className={styles.secondaryBtn} href={loop.odooLink} target="_blank" rel="noopener noreferrer">Open in Odoo</a>
                    : <button type="button" className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open in Odoo</button>}
                </div>
              </article>)
            : <div className={styles.empty}>
                <p className={styles.emptyTitle}>Nothing open</p>
                <p>Odoo answered, and this customer has no open opportunities or tasks.</p>
              </div>}
      </section>}
    </div>
  </main>;
}
