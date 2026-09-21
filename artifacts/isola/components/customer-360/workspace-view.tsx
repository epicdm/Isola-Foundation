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
  Customer360FollowUp,
  Customer360ObjectDetail,
  Customer360Service,
  Customer360Snapshot,
  Customer360Stage,
  Customer360TimelineEntry,
  DetailAvailability,
  LifecycleMilestones,
  Milestone,
  MilestoneStatus,
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

/**
 * Base labels. Every tenant-facing string in this view resolves through here.
 *
 * TAB SET EXTENDED 2026-09-20 (dec-customer-workspace-services-tab-and-6-tab-
 * mapping-2026-09-20, owner-confirmed): 'sales' and 'support' are RENAMED/
 * RELOCATED, not deleted — 'support' becomes 'issues-and-work' (same open-
 * loops content, broader name); 'sales' documents move into the new
 * 'services' tab's own section rather than keeping a separate top-level nav
 * entry, since Personal Line (the first real service) is not a quotation or
 * order. 'conversations' and 'activity' are genuinely new. See each tab's
 * render block below for what is real today vs an honest placeholder.
 */
const BASE_LABELS: Record<string, string> = {
  overview: 'Overview',
  services: 'Services',
  'issues-and-work': 'Issues & Work',
  conversations: 'Conversations',
  billing: 'Billing',
  activity: 'Activity',
};

export type WorkspaceTab = 'overview' | 'services' | 'issues-and-work' | 'conversations' | 'billing' | 'activity';

/** One object opened inside the customer. Null when the customer is the view. */
export type NestedTarget = {
  kind: 'quotation' | 'order' | 'invoice' | 'ticket';
  id: number;
  reference: string;
};

export type NestedPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: Customer360ObjectDetail }
  | { kind: 'message'; text: string };

/**
 * A Personal Line's onboarding checklist, opened on demand from its row in
 * the Services tab. NOT the `nested`/`NestedTarget` mechanism above — that
 * one is closed over Odoo object kinds (`quotation | order | invoice |
 * ticket`) and `Customer360ObjectDetail`'s Odoo-shaped fields (odooLink,
 * paymentState, ...), none of which a Personal Line has. Forcing this into
 * that shape would be exactly the kind of guess `detailKindFor`'s own
 * comment already warns against for a record type with no validated spec —
 * a Personal Line has one here, so it gets its own small, parallel state
 * instead of stretching an unrelated one.
 *
 * Keyed by `did`, the same stable, real-world identifier `Customer360Service`
 * itself is keyed on — never a synthetic id, and never liteAccountId, which
 * must not exist on this side of the fetch at all (the container's job).
 */
export type LifecyclePhase =
  | { kind: 'loading' }
  | { kind: 'ready'; lifecycle: LifecycleMilestones }
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
   * A Personal Line's onboarding checklist, opened on demand from its row in
   * the Services tab. Keyed by `did`, not `NestedTarget` — see
   * `LifecyclePhase`'s own header. `undefined` for a `did` with no drill-down
   * open (distinguishing "no service was clicked" from `null`, which
   * `LifecycleChecklist` already uses for "opened, but no checklist to show").
   */
  lifecycleDrillDown: { did: string; phase: LifecyclePhase } | null;
  onOpenLifecycle: (did: string) => void;
  onCloseLifecycle: () => void;

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

  /**
   * The prepare-reply dialog. Local text editing only — no network.
   *
   * `onReplyOpen` takes an OPTIONAL prefill: the identity bar's generic
   * Message button opens it with none (falls back to the recommended
   * action's own suggestedReply, unchanged behaviour); a record's Message
   * button (NestedObject) supplies one naming that record — "About invoice
   * INV-2231: " — the design's quickMessage pattern, carried through rather
   * than reinvented as a second composer.
   */
  replyOpen: boolean;
  onReplyOpen: (prefillText?: string) => void;
  onReplyClose: () => void;
  /** The prefill the container is currently holding, if any. Read only while
   *  replyOpen — the container clears it on close. */
  replyPrefill?: string;

  /**
   * Where the message would be posted, for display only. The view never
   * resolves this and never sends it anywhere — the container owns the locator.
   */
  destinationLabel: string | null;

  domain?: WorkspaceDomain;
  onNavigate?: (target: NavTarget) => void;

  /**
   * Rendered only when the container has somewhere real to send it. The
   * Chatwoot container has no customer list to return to; the portal
   * container does. A dead-end back-link is worse than none — same
   * reasoning `sendability`/`can.why` already apply to buttons.
   */
  onBackToCustomers?: () => void;

  /**
   * The reverse of the Personal Lines list → customer → Services → line loop
   * (owner, 2026-09-20: "and the reverse navigation"). Same rule as
   * `onBackToCustomers`: rendered only when the container has a Personal
   * Lines surface to send it to. The Chatwoot container has none; the portal
   * container does, and it owns the routing — the view never builds a URL.
   * `onOpenPersonalLine` receives the row's `did`, the only identifier the
   * Services snapshot carries (never a liteAccountId — see
   * def-personal-line-service-detail-leaks-bffv2-join-key-2026-09-19).
   */
  onOpenPersonalLines?: () => void;
  onOpenPersonalLine?: (did: string) => void;

  /**
   * "Create follow-up task" — a real mail.activity write, not a toast. The
   * view supplies no note text or due date: the container computes
   * "Follow up — {name}" / tomorrow's real date, matching the design's own
   * one-click pattern, and the view only reports whether a write is
   * in flight so the button can't be double-clicked into two rows.
   */
  onCreateFollowUp?: () => void;
  creatingFollowUp?: boolean;
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

/** Up to two initials, from real name words — never a placeholder glyph. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Balances are never combined; each currency is its own line. */
function formatBalances(balances: Customer360Snapshot['balances']): string {
  if (!balances.length) return 'No posted balance';
  return balances.map((b) => formatMoney(b.amount, b.currency)).join(' + ');
}

/** Same shape as formatBalances, generalised to any per-currency figure —
 *  lifetime value reuses it rather than growing its own formatter. */
function formatPerCurrency(rows: Customer360Snapshot['balances'], empty: string): string {
  if (!rows.length) return empty;
  return rows.map((r) => formatMoney(r.amount, r.currency)).join(' + ');
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

/**
 * Review, edit and copy a message. Local text only — no network.
 *
 * TWO ORIGINS, ONE DIALOG. `initialText` set means a record's Message
 * button opened this with a contextual prefill ("About invoice X: ") — the
 * design's quickMessage pattern. `initialText` absent falls back to the one
 * evidence-gated recommendation this snapshot may carry, unchanged from
 * before this dialog took a second origin. Neither present means nothing to
 * show — the same "withholding is honest" rule `recommendedAction` itself
 * already follows.
 */
export function ReplyReview({ snapshot, initialText, onClose }: {
  snapshot: Customer360Snapshot;
  initialText?: string;
  onClose: () => void;
}) {
  const action = snapshot.recommendedAction;
  const [draft, setDraft] = useState(initialText ?? action?.suggestedReply ?? '');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (initialText === undefined && !action) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Review suggested reply">
      <section className={styles.reviewCard}>
        <h2>Review before you use this</h2>
        <dl className={styles.reviewFacts}>
          <div><dt>Customer</dt><dd>{snapshot.customer.name}</dd></div>
          {/* The document facts are specific to the ONE evidence-backed
              recommendation. A record-triggered message names its own
              record inside the prefilled text itself, so nothing invented
              is needed here when there is no `action` to describe. */}
          {action && <>
            <div><dt>Quotation</dt><dd>{action.document.reference} · {action.document.state ?? 'state unavailable'}</dd></div>
            <div><dt>Amount</dt><dd>{formatMoney(action.document.total, action.document.currency)}</dd></div>
          </>}
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

/**
 * The design's quickMessage prefill, by kind. Quotation and order share the
 * same "About order" wording the reference itself uses (it does not
 * distinguish them for messaging purposes either).
 */
function messagePrefillFor(target: NestedTarget): string {
  if (target.kind === 'invoice') return `About invoice ${target.reference}: `;
  if (target.kind === 'ticket') return 'Update on your ticket: ';
  return `About order ${target.reference}: `;
}

type NestedSubTab = 'overview' | 'lines' | 'payments' | 'diagnosis' | 'resolution';

function NestedObject({ target, phase, onBack, onMessage }: {
  target: NestedTarget;
  phase: NestedPhase;
  onBack: () => void;
  /**
   * Real Odoo write paths this workspace can act on (Send to customer,
   * governed content) are separate flows, already wired. This is the OTHER
   * kind of action the design's `quickMessage` names: reach for the phone
   * without leaving the record. It opens the same prepare-reply dialog the
   * identity bar's Message button does — real and wired, not fabricated —
   * rather than inventing a second composer. The prefill names the record,
   * matching the design's pattern exactly.
   */
  onMessage: (prefillText?: string) => void;
}) {
  const [sub, setSub] = useState<NestedSubTab>('overview');
  const isInvoice = target.kind === 'invoice';
  const isTicket = target.kind === 'ticket';

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
        {/* A ticket has no amount — Odoo's own field, never a placeholder
            "$0.00" that would read as a real figure. */}
        {!isTicket && <span className={`${styles.rowAmount} ${styles.tnum}`}>
          {formatMoney(phase.detail.total, phase.detail.currency)}
        </span>}
        {/* MESSAGE IS THE PRIMARY VERB. Odoo is the escape hatch, not the
            default path — leaving the record to look something up is the
            failure mode this in-app pattern exists to close. */}
        <button type="button" className={styles.primaryBtnWa} onClick={() => onMessage(messagePrefillFor(target))}>Message</button>
        {phase.detail.odooLink
          ? <a className={styles.secondaryBtn} href={phase.detail.odooLink} target="_blank" rel="noopener noreferrer" title="Escape hatch — leaves this record">Open in Odoo</a>
          : <button type="button" className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open in Odoo</button>}
      </div>

      {/* No ribbon for a ticket — see readTicketObject's own note: an
          honest ribbon needs this instance's real, team-scoped
          helpdesk.stage sequence, unverified, so none is drawn. The real
          stage NAME still travels, as a fact below, not a fabricated step. */}
      <StageRail stages={phase.detail.stages} />

      <nav className={styles.subTabs} aria-label={`${phase.detail.reference} sections`}>
        {(isTicket
          ? [['overview', 'Overview'], ['diagnosis', 'Diagnosis'], ['resolution', 'Resolution']] as const
          : [['overview', 'Overview'], ['lines', 'Lines'], ...(isInvoice ? [['payments', 'Payments'] as const] : [])] as const
        ).map(([id, lbl]) => (
          <button
            key={id}
            type="button"
            className={`${styles.subTab} ${sub === id ? styles.subTabOn : ''}`}
            aria-current={sub === id ? 'true' : undefined}
            onClick={() => setSub(id)}
          >{lbl}</button>
        ))}
      </nav>

      {sub === 'overview' && isTicket && <dl className={styles.reviewFacts}>
        <div><dt>Stage</dt><dd>{phase.detail.state ?? 'unavailable'}</dd></div>
        <div><dt>Priority</dt><dd>{phase.detail.priority ?? 'unavailable'}</dd></div>
        <div><dt>Assigned to</dt><dd>{phase.detail.assignee ?? 'Unassigned'}</dd></div>
        <div><dt>Opened</dt><dd>{phase.detail.date ?? '—'}</dd></div>
      </dl>}

      {sub === 'overview' && !isTicket && <dl className={styles.reviewFacts}>
        <div><dt>State</dt><dd>{phase.detail.state ?? 'unavailable'}</dd></div>
        {isInvoice && <div><dt>Payment</dt><dd>{phase.detail.paymentState ?? 'unavailable'}</dd></div>}
        <div><dt>Dated</dt><dd>{phase.detail.date ?? '—'}</dd></div>
        <div><dt>Total</dt><dd className={styles.tnum}>{formatMoney(phase.detail.total, phase.detail.currency)}</dd></div>
      </dl>}

      {/* No automated diagnosis exists — this reads exactly one real field
          (priority) and says so plainly, rather than showing an AI verdict
          this workspace cannot actually produce. */}
      {sub === 'diagnosis' && <div className={styles.unavailable}>
        <strong>No automated diagnosis is available.</strong>
        This shows the ticket's own recorded priority ({phase.detail.priority ?? 'unavailable'}) — Isola does not run
        fault diagnosis on helpdesk tickets today.
      </div>}

      {/* Same honesty: "resolution" here is the record's own last-updated
          fact, not a resolution narrative nobody wrote. */}
      {sub === 'resolution' && <dl className={styles.reviewFacts}>
        <div><dt>Current stage</dt><dd>{phase.detail.state ?? 'unavailable'}</dd></div>
        <div><dt>Last updated</dt><dd>{phase.detail.updatedAt ?? 'unavailable'}</dd></div>
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

/**
 * "Suggested next actions" — the left column's top card. Reuses
 * `RecommendedActionCard` rather than duplicating its evidence-gated logic;
 * an honest empty card renders when Odoo produced no recommendation, so the
 * column never collapses to nothing without saying why.
 */
function SuggestedNextActionsPanel({ snapshot, onPrepareReply }: {
  snapshot: Customer360Snapshot;
  onPrepareReply: () => void;
}) {
  if (!snapshot.recommendedAction) {
    return <section className={styles.card}>
      <div className={styles.sectionHead}>
        <div><span className={styles.eyebrow}>Suggested next actions</span></div>
      </div>
      <div className={styles.empty}><p>No document currently warrants a recommendation.</p></div>
    </section>;
  }
  return <div className={styles.card}>
    <RecommendedActionCard snapshot={snapshot} onPrepareReply={onPrepareReply} />
  </div>;
}

/**
 * A panel with no real source yet. NOT Odoo, and not fabricated — the reason
 * names exactly what would need to exist for this to become real, matching
 * the wording convention `notConnectedAdapter` already uses elsewhere in this
 * workspace's other data path.
 */
function NotBuiltPanel({ title, reason }: { title: string; reason: string }) {
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>{title}</span></div>
    </div>
    <div className={styles.notBuilt}>
      <strong>Not connected yet</strong>
      {reason}
    </div>
  </section>;
}

/**
 * Personal Line is the first real service kind (dec-customer-workspace-
 * services-tab-and-6-tab-mapping-2026-09-20). `servicesAvailable` and an
 * empty `services` array are NEVER conflated — same discipline as
 * openLoopsAvailable/followUpsAvailable above: a bff-v2 outage must read as
 * "could not check", never as "this customer has none". Registration
 * (proven SIP calling status), wallet assignment and creation date are kept
 * as separate labeled rows, never merged into one status word, so a reader
 * is never left guessing which of the three a single claim is about.
 */
function ServicesPanel({
  snapshot, lifecycleDrillDown, onOpenLifecycle, onCloseLifecycle, onOpenPersonalLines, onOpenPersonalLine,
}: {
  snapshot: Customer360Snapshot;
  lifecycleDrillDown: { did: string; phase: LifecyclePhase } | null;
  onOpenLifecycle: (did: string) => void;
  onCloseLifecycle: () => void;
  onOpenPersonalLines?: () => void;
  onOpenPersonalLine?: (did: string) => void;
}) {
  const services = snapshot.services;
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Services</span><h2>Personal Line</h2></div>
      {onOpenPersonalLines && (
        <button type="button" className={styles.backLink} onClick={onOpenPersonalLines} data-reverse-nav="personal-lines">
          Personal Lines <span aria-hidden="true">→</span>
        </button>
      )}
    </div>
    {!snapshot.servicesAvailable
      ? <div className={styles.unavailable}>
          <strong>bff-v2 did not answer for services.</strong>
          This is not a statement that this customer has none.
        </div>
      : services.length === 0
        ? <div className={styles.empty}>
            <p className={styles.emptyTitle}>No services</p>
            <p>bff-v2 answered, and this customer holds no Personal Line.</p>
          </div>
        : <div className={styles.cardPad}>
            {services.map((s: Customer360Service, i: number) => <div
              key={s.did}
              className={styles.summaryList}
              style={i > 0 ? { marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' } : undefined}
            >
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Personal Line</span>
                <span className={styles.summaryValue}>{s.did}</span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Registration</span>
                <span className={styles.summaryValue}>
                  {s.sipRegistered === null
                    ? 'Unknown — no SIP identity yet, or the check failed'
                    : s.sipRegistered ? 'Registered' : 'Not registered'}
                </span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Wallet</span>
                <span className={styles.summaryValue}>{s.magnusUserAssigned ? 'Assigned' : 'Not assigned'}</span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Created</span>
                <span className={styles.summaryValue}>
                  {s.createdAt
                    ? new Date(s.createdAt).toLocaleDateString('en-DM', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'Unavailable'}
                </span>
              </div>
              {onOpenPersonalLine && (
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => onOpenPersonalLine(s.did)}
                    data-reverse-nav="personal-line"
                    data-did={s.did}
                  >
                    Open in Personal Lines
                  </button>
                </div>
              )}
              <LifecycleChecklist
                did={s.did}
                drillDown={lifecycleDrillDown?.did === s.did ? lifecycleDrillDown : null}
                onOpen={() => onOpenLifecycle(s.did)}
                onClose={onCloseLifecycle}
              />
            </div>)}
          </div>}
  </section>;
}

/**
 * Onboarding/lifecycle checklist (owner baseline, 2026-09-20: onboarding
 * status is CONTEXT for the concierge's continuing relationship with a
 * customer, not a standalone deliverable — so it renders INSIDE this same
 * service card, never as its own tab or panel).
 *
 * ON DEMAND, NOT ON LOAD (dec-... 2026-09-21 design reconciliation with
 * AGENT lane): the six-milestone derivation is expensive enough
 * (AgentActivity, call history, plan subscription reads) that computing it
 * for every service on every Services-tab open would cost N× that for
 * however many lines a customer holds. This card starts collapsed with a
 * single toggle; the fetch only happens once an operator actually asks.
 */
function LifecycleChecklist({
  did, drillDown, onOpen, onClose,
}: {
  did: string;
  drillDown: { did: string; phase: LifecyclePhase } | null;
  onOpen: () => void;
  onClose: () => void;
}) {
  if (!drillDown) {
    return <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <button type="button" className={styles.secondaryBtn} onClick={onOpen}>
        View onboarding status
      </button>
    </div>;
  }

  const { phase } = drillDown;

  return <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
    <div className={styles.sectionHead} style={{ marginBottom: phase.kind === 'ready' ? 6 : 0 }}>
      <div className={styles.eyebrow}>Onboarding</div>
      <button type="button" className={styles.secondaryBtn} onClick={onClose}>Hide</button>
    </div>
    {phase.kind === 'loading' && <p className={styles.copyHint}>Checking…</p>}
    {phase.kind === 'message' && <div className={styles.unavailable}>
      <strong>Could not be determined right now.</strong>
      {phase.text}
    </div>}
    {phase.kind === 'ready' && <LifecycleRows lifecycle={phase.lifecycle} />}
  </div>;
}

function LifecycleRows({ lifecycle }: { lifecycle: LifecycleMilestones }) {
  const rows: Array<{ label: string; milestone: Milestone }> = [
    { label: 'Signed up', milestone: lifecycle.signup },
    { label: 'Number assigned', milestone: lifecycle.number_assigned },
    { label: 'Calling app registered', milestone: lifecycle.sip_registered },
    { label: 'First confirmation or call', milestone: lifecycle.first_confirmation_or_call },
    { label: 'Trial or plan active', milestone: lifecycle.trial_or_plan_active },
    { label: 'Linked to Odoo customer', milestone: lifecycle.odoo_linked },
  ];
  return <ul className={styles.listRows}>
    {rows.map((r) => <li key={r.label} className={styles.listRow}>
      <div className={styles.listRowMain}>
        <div className={styles.listRowTitle}>{r.label}</div>
        {(r.milestone.failureReason || r.milestone.nextAction) && <div className={styles.rowMeta}>
          {r.milestone.failureReason ?? r.milestone.nextAction}
        </div>}
      </div>
      <span className={milestoneStateClass(r.milestone.status)}>{milestoneStateLabel(r.milestone.status)}</span>
    </li>)}
  </ul>;
}

/** Wording a customer-relationship reader recognizes at a glance — never the
 *  raw enum value, same "the word is the label" idiom `.state`'s own CSS
 *  comment states for every other status chip in this file. */
function milestoneStateLabel(status: MilestoneStatus): string {
  if (status === 'done') return 'Done';
  if (status === 'pending') return 'Not yet';
  if (status === 'blocked') return 'Blocked';
  return 'Unknown';
}

function milestoneStateClass(status: MilestoneStatus): string {
  if (status === 'done') return `${styles.state} ${styles.stateOk}`;
  if (status === 'blocked') return `${styles.state} ${styles.stateDanger}`;
  if (status === 'unknown') return `${styles.state} ${styles.stateWarn}`;
  return styles.state;
}

/** Real Odoo fields only. A field this customer's record does not have shows
 *  an honest placeholder, never a blank cell that reads as a loading state. */
function AccountSummaryPanel({ snapshot }: { snapshot: Customer360Snapshot }) {
  const c = snapshot.customer;
  const since = c.customerSince
    ? new Date(c.customerSince).toLocaleDateString('en-DM', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Account</span><h2>Account summary</h2></div>
    </div>
    <div className={`${styles.cardPad} ${styles.summaryList}`}>
      <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Company</span>
        <span className={styles.summaryValue}>{c.companyName ?? (c.isCompany ? c.name : '—')}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Phone</span>
        <span className={styles.summaryValue}>{c.phone ?? 'No phone'}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Email</span>
        <span className={styles.summaryValue}>{c.email ?? 'No email'}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Customer since</span>
        <span className={styles.summaryValue}>{since ?? 'Unavailable'}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Lifetime value</span>
        <span className={`${styles.summaryValue} ${styles.tnum}`}>
          {formatPerCurrency(snapshot.lifetimeValue, 'No posted invoices')}
        </span>
      </div>
      {c.tags.length > 0 && <div className={styles.summaryRow}>
        <span className={styles.summaryKey}>Tags</span>
        <span className={styles.tagRow}>{c.tags.map((t) => <span key={t} className={styles.tagChip}>{t}</span>)}</span>
      </div>}
    </div>
  </section>;
}

/** crm.lead, filtered to the opportunity kind already read into openLoops —
 *  no second Odoo call. Empty and unavailable are never conflated: see
 *  openLoopsAvailable's own docstring in contracts.ts. */
function OpenDealPanel({ snapshot }: { snapshot: Customer360Snapshot }) {
  const deal = snapshot.openLoops.find((l) => l.kind === 'opportunity') ?? null;
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Pipeline</span><h2>Open deal</h2></div>
    </div>
    {!snapshot.openLoopsAvailable
      ? <div className={styles.unavailable}>
          <strong>Odoo did not answer for opportunities.</strong>
          This is not a statement that there is none.
        </div>
      : !deal
        ? <div className={styles.empty}>
            <p className={styles.emptyTitle}>No open deal</p>
            <p>Odoo answered, and this customer has no open opportunity.</p>
          </div>
        : <div className={styles.cardPad}>
            <p className={styles.rowRef}>{deal.title}</p>
            <p className={styles.rowMeta}>
              <span className={styles.state}>{deal.state ?? 'Stage unavailable'}</span>
              {deal.value != null && <span className={styles.tnum}>{formatMoney(deal.value, null)}</span>}
              {deal.due && <span>Due {deal.due}</span>}
            </p>
            {deal.odooLink
              ? <a className={styles.secondaryBtn} href={deal.odooLink} target="_blank" rel="noopener noreferrer">Open in Odoo</a>
              : <button type="button" className={styles.secondaryBtn} disabled title="No verified deep link for this record">Open in Odoo</button>}
          </div>}
  </section>;
}

/** The right rail's own owed figure — the identity bar carries a compact
 *  version too; this is the detail card the reference gives it its own
 *  space for. Same balances, never recomputed. */
function OwedCard({ snapshot }: { snapshot: Customer360Snapshot }) {
  return <section className={`${styles.card} ${styles.cardPad}`}>
    <span className={styles.eyebrow}>Owed</span>
    <strong className={`${styles.tileValue} ${styles.tnum}`} style={{ display: 'block', marginTop: 6 }}>
      {formatBalances(snapshot.balances)}
    </strong>
    {snapshot.balances.length > 1 && <p className={styles.tileNote}>Separate currencies — not combined</p>}
  </section>;
}

/** The reference's right rail ends in an inline thread + compose box. That is
 *  a real, separate build (message history plus a send path already proven
 *  in the Messages tab) — not something to fake here. Honest placeholder,
 *  same vocabulary as NotBuiltPanel, naming exactly what exists today. */
function InlineConversationPanel({ destinationLabel }: { destinationLabel: string | null }) {
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Conversation</span><h2>WhatsApp thread</h2></div>
    </div>
    <div className={styles.notBuilt}>
      <strong>Not wired inline yet</strong>
      The message thread{destinationLabel ? ` for ${destinationLabel}` : ''} is not rendered in this panel. Use the
      Messages tab beside this one to read and reply until this is built.
    </div>
  </section>;
}

/** Real mail.activity rows. "Add" writes one for real (onCreate), matching
 *  the design's own one-click pattern — no free-form dialog, tomorrow's
 *  real date, computed by the container so this view stays pure. */
function FollowUpsPanel({ snapshot, onCreate, creating }: {
  snapshot: Customer360Snapshot;
  onCreate?: () => void;
  creating: boolean;
}) {
  const rows = snapshot.followUps;
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div>
        <span className={styles.eyebrow}>Follow-ups</span>
        <h2>{rows.length ? `${rows.length} open` : 'Nothing open'}</h2>
      </div>
      {onCreate && <button type="button" className={styles.tileLink} onClick={onCreate} disabled={creating}>
        {creating ? 'Adding…' : '+ Add'}
      </button>}
    </div>
    {!snapshot.followUpsAvailable
      ? <div className={styles.unavailable}>
          <strong>Odoo did not answer for follow-ups.</strong>
          This is not a statement that there is none.
        </div>
      : rows.length
        ? <div className={styles.cardPad}>
            {rows.map((f: Customer360FollowUp) => <div className={styles.followUpRow} key={f.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={styles.followUpSummary}>{f.summary}</div>
                {f.assignee && <div className={styles.followUpMeta}>{f.assignee}</div>}
              </div>
              <span className={`${styles.followUpDue} ${f.dueLabel === 'Today' ? styles.followUpDueToday : ''}`}>
                {f.dueLabel}
              </span>
            </div>)}
          </div>
        : <div className={styles.empty}><p>No open follow-ups for this customer.</p></div>}
  </section>;
}

const TIMELINE_ICON: Record<Customer360TimelineEntry['kind'], string> = {
  message: styles.timelineIconMessage,
  order: styles.timelineIconOrder,
  invoice: styles.timelineIconInvoice,
};
const TIMELINE_GLYPH: Record<Customer360TimelineEntry['kind'], string> = {
  message: '💬',
  order: '📦',
  invoice: '$',
};

/** Messages, orders and invoices already read for this snapshot, merged
 *  into one chronological stream — no second Odoo/Chatwoot call. Calls are
 *  named as absent, never faked as a call that did not happen. */
function TimelineSection({ snapshot }: { snapshot: Customer360Snapshot }) {
  return <section className={styles.card}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>History</span><h2>Timeline</h2></div>
    </div>
    <div className={styles.unavailable} style={{ margin: '0 18px 12px' }}>
      {snapshot.timelineCallsNote}
    </div>
    {snapshot.timeline.length
      ? <div className={styles.cardPad}>
          {snapshot.timeline.map((e) => <div className={styles.timelineRow} key={e.id}>
            <span className={`${styles.timelineIcon} ${TIMELINE_ICON[e.kind]}`} aria-hidden="true">{TIMELINE_GLYPH[e.kind]}</span>
            <div className={styles.timelineBody}>
              <div className={styles.timelineHead}>
                <span className={styles.timelineTitle}>
                  {e.kind === 'message' ? (e.from === 'customer' ? 'Customer message' : 'Reply') : e.reference}
                </span>
                <span className={styles.timelineDate}>{e.date.slice(0, 10)}</span>
              </div>
              {e.kind === 'message' && <p className={styles.timelineText}>{e.text}</p>}
              {e.kind !== 'message' && <p className={styles.timelineText}>
                {e.status ?? 'State unavailable'}{e.total != null ? ` · ${formatMoney(e.total, e.currency ?? null)}` : ''}
              </p>}
            </div>
          </div>)}
        </div>
      : <div className={styles.empty}><p>No messages, orders or invoices to show yet.</p></div>}
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
    lifecycleDrillDown, onOpenLifecycle, onCloseLifecycle,
    outcomeFor, send, onSendOpen, onSendConfirm, onSendClose,
    replyOpen, onReplyOpen, onReplyClose, replyPrefill, destinationLabel, domain,
    onBackToCustomers, onOpenPersonalLines, onOpenPersonalLine, onCreateFollowUp, creatingFollowUp,
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
    // Real service instances (Personal Line first) plus quotations/orders,
    // which render inside this same tab. Services is counted only when
    // bff-v2 actually answered -- same "only a successful read produces a
    // count" rule 'issues-and-work' below already applies, so a bff-v2
    // outage never understates as "just the sales docs" nor overstates as
    // "definitely none". Sales docs still count on their own when services
    // itself is unavailable, since that read did succeed.
    services: salesDocs.length + (snapshot.servicesAvailable ? snapshot.services.length : 0) || undefined,
    billing: invoiceDocs.length || undefined,
    // Only a successful read may produce a count. When Odoo did not answer we
    // show no badge rather than a zero that would read as "none exist".
    'issues-and-work': snapshot.openLoopsAvailable ? loops.length || undefined : undefined,
  };

  const TABS: WorkspaceTab[] = ['overview', 'services', 'issues-and-work', 'conversations', 'billing', 'activity'];

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
      {onBackToCustomers && (
        <button type="button" className={styles.backLink} onClick={onBackToCustomers}>
          <span aria-hidden="true">←</span> Customers
        </button>
      )}
      <span className={styles.avatar} aria-hidden="true">{initials(snapshot.customer.name)}</span>
      <div className={styles.identityBody}>
        <h1 className={styles.identityTitle}>{snapshot.customer.name}</h1>
        {snapshot.customer.companyName && (
          <p className={styles.companyLine}>{snapshot.customer.companyName}</p>
        )}
        <p className={styles.identityMeta}>
          <span>{snapshot.customer.phone ?? 'No phone'}</span>
          <span>·</span>
          <span>{snapshot.customer.email ?? 'No email'}</span>
        </p>
        {snapshot.customer.tags.length > 0 && (
          <p className={styles.identityTags}>
            {snapshot.customer.tags.map((t) => <span key={t} className={styles.tagChip}>{t}</span>)}
          </p>
        )}
      </div>
      <span className={styles.verifiedChip}>Verified Odoo customer</span>
      <div className={styles.identityActions}>
        <button
          type="button"
          className={styles.iconBtn}
          disabled
          title="Voice calling is not connected in this workspace yet"
        >
          Call
        </button>
        <button type="button" className={`${styles.iconBtn} ${styles.iconBtnWa}`} onClick={() => onReplyOpen()}>
          Message
        </button>
      </div>
      <div className={styles.balanceBlock}>
        <span className={styles.balanceLabel}>Balance due</span>
        <strong className={`${styles.balanceValue} ${styles.tnum}`}>{formatBalances(snapshot.balances)}</strong>
        <small className={`${styles.balanceNote} ${freshnessClass ?? ''}`}>
          {snapshot.balances.length > 1 ? 'Separate currencies — not combined' : freshnessText}
        </small>
      </div>
    </header>

    {replyOpen && <ReplyReview snapshot={snapshot} initialText={replyPrefill} onClose={onReplyClose} />}
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
      {nested && <NestedObject target={nested.target} phase={nested.phase} onBack={onCloseObject} onMessage={onReplyOpen} />}

      {!nested && tab === 'overview' && <div className={styles.recordGrid}>
        <div className={styles.railCol}>
          <SuggestedNextActionsPanel snapshot={snapshot} onPrepareReply={onReplyOpen} />
          <NotBuiltPanel
            title="AI insights"
            reason="Derived figures (trend, risk score) need a computation this workspace does not have yet. None are fabricated here."
          />
          <FollowUpsPanel
            snapshot={snapshot}
            onCreate={onCreateFollowUp}
            creating={creatingFollowUp ?? false}
          />
        </div>

        <div className={styles.railCol}>
          <AccountSummaryPanel snapshot={snapshot} />
          <OpenDealPanel snapshot={snapshot} />
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <div><span className={styles.eyebrow}>{label(domain, 'services')}</span><h2>Orders</h2></div>
            </div>
            <div className={styles.cardPad}>
              <strong className={`${styles.tileValue} ${styles.tnum}`}>{salesDocs.length}</strong>
              <p className={styles.tileNote}>{salesDocs.length === 1 ? 'quotation or order' : 'quotations and orders'}</p>
              <button type="button" className={styles.tileLink} onClick={() => onTabChange('services')}>Review services →</button>
            </div>
          </section>
        </div>

        <div className={styles.railCol}>
          <OwedCard snapshot={snapshot} />
        </div>
      </div>}

      {/*
        SERVICES (new tab, 2026-09-20): quotations/orders relocate here from
        the removed 'sales' tab, unchanged in behaviour — a customer's real
        service instances (Personal Line first) belong here too, once a
        container populates them. Nothing about salesDocs' own display logic
        changed; only its tab moved.
      */}
      {!nested && tab === 'services' && <>
        <ServicesPanel
          snapshot={snapshot}
          lifecycleDrillDown={lifecycleDrillDown}
          onOpenLifecycle={onOpenLifecycle}
          onCloseLifecycle={onCloseLifecycle}
          onOpenPersonalLines={onOpenPersonalLines}
          onOpenPersonalLine={onOpenPersonalLine}
        />
        <DocumentList
          title="Quotations and orders"
          note="Review the source record before sending anything."
          empty="Odoo answered, and this customer has no quotations or orders."
          items={salesDocs} outcomeFor={outcomeFor} onSend={onSendOpen} onOpen={onOpenObject} />
      </>}

      {!nested && tab === 'billing' && <DocumentList
        title="Invoices"
        note="Only a posted invoice can be sent to a customer."
        empty="Odoo answered, and this customer has no invoices."
        items={invoiceDocs} outcomeFor={outcomeFor} onSend={onSendOpen} onOpen={onOpenObject} />}

      {/*
        CONVERSATIONS (new tab, 2026-09-20): relocated from Overview, unchanged
        content — the merged message/order/invoice timeline and the inline-
        thread placeholder both belong to "conversations" more than to a
        general Overview, and Overview was already getting crowded.
      */}
      {!nested && tab === 'conversations' && <>
        <InlineConversationPanel destinationLabel={destinationLabel} />
        <div className={styles.timelineSection}>
          <TimelineSection snapshot={snapshot} />
        </div>
      </>}

      {/*
        ACTIVITY (new tab, 2026-09-20): no real audit/event-log source exists
        in this snapshot yet — honest placeholder, same NotBuiltPanel idiom
        used elsewhere in this file, not a fabricated feed.
      */}
      {!nested && tab === 'activity' && <NotBuiltPanel
        title="Activity"
        reason="An audit/event log (who changed what, when) needs a real source this workspace does not read yet. Follow-ups and the conversation timeline (see Overview and Conversations) are the closest real signal available today."
      />}

      {!nested && tab === 'issues-and-work' && <section className={styles.card}>
        <div className={styles.sectionHead}>
          <div><span className={styles.eyebrow}>Close the loop</span><h2>Open customer work</h2></div>
          <p>Review before creating a duplicate.</p>
        </div>
        {!snapshot.openLoopsAvailable
          ? <div className={styles.unavailable}>
              <strong>Odoo did not answer for opportunities, tasks or tickets.</strong>
              This is not a statement that there is none. Open the customer in Odoo before
              assuming there is no open work.
            </div>
          : loops.length
            ? loops.map((loop) => <article className={styles.row} key={`${loop.kind}-${loop.id}`}>
                <div className={styles.rowBody}>
                  {/* A ticket opens IN PLACE, same pattern as an order or
                      invoice row. Opportunities and tasks stay link-only —
                      unchanged, out of scope for this pass. */}
                  {loop.kind === 'ticket'
                    ? <button
                        type="button"
                        className={styles.rowOpen}
                        onClick={() => onOpenObject({ kind: 'ticket', id: loop.id, reference: loop.title })}
                      >{loop.title}</button>
                    : <div className={styles.rowRef}>{loop.title}</div>}
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
                <p>Odoo answered, and this customer has no open opportunities, tasks or tickets.</p>
              </div>}
      </section>}
    </div>
  </main>;
}
