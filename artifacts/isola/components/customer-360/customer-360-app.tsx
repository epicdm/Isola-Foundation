'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CHATWOOT_FETCH_INFO_REQUEST,
  parseChatwootContext,
  type ChatwootContextHint,
} from '@/lib/customer-360/chatwoot-context';
import type { Customer360Response, Customer360Snapshot } from '@/lib/customer-360/contracts';
import { sendBadgeText, type SendOutcome } from '@/lib/customer-360/send-badge';
import styles from './customer-360.module.css';

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loading'; hint: ChatwootContextHint }
  // The hint is carried into `ready` because S8-W1 needs to name the exact
  // conversation it is posting into, and that locator must be the same one the
  // snapshot was resolved from — not re-derived later from a second message.
  | { kind: 'ready'; snapshot: Customer360Snapshot; hint: ChatwootContextHint }
  | { kind: 'message'; title: string; body: string; retry?: ChatwootContextHint };

/**
 * Format an amount in ITS OWN currency.
 *
 * The previous single formatter hardcoded XCD and was applied to every figure,
 * so a USD invoice rendered as EC$. A wrong number wearing a confident currency
 * symbol is the failure mode this workspace exists to prevent: an operator can
 * read it straight to a customer. When Odoo did not give us a currency we show
 * the bare amount and say so, rather than guessing one.
 */
function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
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

function loadSnapshot(hint: ChatwootContextHint, setPhase: (phase: Phase) => void) {
  setPhase({ kind: 'loading', hint });
  fetch('/api/isola-360/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hint }),
  })
    .then(async (response) => {
      if (response.status === 401) throw new Error('Sign in to Isola, then return to this tab.');
      const result = await response.json() as Customer360Response;
      if (result.state === 'ready') setPhase({ kind: 'ready', snapshot: result.snapshot, hint });
      else setPhase({ kind: 'message', title: 'Customer 360 needs attention', body: result.message, retry: hint });
    })
    .catch((error) => {
      setPhase({ kind: 'message', title: 'Customer 360 is unavailable', body: error instanceof Error ? error.message : 'Try again.', retry: hint });
    });
}

/** S3: the review/edit/copy surface for one suggested reply. No network call. */
export function ReplyReview({
  snapshot,
  onClose,
}: {
  snapshot: Customer360Snapshot;
  onClose: () => void;
}) {
  const action = snapshot.recommendedAction;
  const [draft, setDraft] = useState(action?.suggestedReply ?? '');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  if (!action) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Review suggested reply">
      <section className={styles.reviewCard}>
        <h2>Review before you use this</h2>
        <dl className={styles.reviewFacts}>
          <div><dt>Customer</dt><dd>{snapshot.customer.name}</dd></div>
          <div><dt>Conversation</dt><dd>#{snapshot.conversation.displayId}</dd></div>
          <div><dt>Quotation</dt><dd>{action.document.reference} · {action.document.state ?? 'state unavailable'}</dd></div>
          <div><dt>Amount</dt><dd>{formatMoney(action.document.total, action.document.currency)}</dd></div>
        </dl>

        <label className={styles.replyLabel} htmlFor="c360-reply-draft">Proposed reply — edit freely</label>
        <textarea
          ref={textareaRef}
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
          <button
            className={styles.secondaryBtn}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={styles.primaryBtn}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft);
                setCopyState('copied');
              } catch {
                // Measured: Chatwoot's Dashboard App iframe carries no
                // allow="clipboard-write", so the Clipboard API is denied by
                // the browser's default Permissions Policy for cross-origin
                // iframes. Selecting the text turns the honest fallback
                // message into a one-keystroke (Ctrl/Cmd+C) action instead
                // of requiring the operator to click into the box and
                // select-all themselves.
                textareaRef.current?.select();
                setCopyState('failed');
              }
            }}
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Selected — press Ctrl/Cmd+C to copy' : 'Copy suggested reply'}
          </button>
        </div>
        <p className={styles.copyHint}>
          Chatwoot does not currently support inserting text into its reply box from a
          Dashboard App — this copies the text so you can paste it into your reply yourself.
        </p>
      </section>
    </div>
  );
}

/** S3: one evidence-backed recommendation, shown only when Odoo produced one. */
export function RecommendedActionCard({
  snapshot,
  onPrepareReply,
}: {
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

// The badge wording lives in lib/customer-360/send-badge.ts, free of CSS
// imports, so a test can actually execute it. See that module's header.
export type { SendOutcome };

type SendPhase =
  | { kind: 'previewing' }
  | { kind: 'reviewing'; body: string; fingerprint: string }
  | { kind: 'sending'; body: string }
  | { kind: 'settled'; outcome: SendOutcome }
  | { kind: 'refused'; detail: string };

/** A key that is stable for one document in one conversation. */
export function documentKey(hint: ChatwootContextHint, doc: Customer360Snapshot['documents'][number]): string {
  return `${hint.conversationDisplayIdHint}:${doc.kind}:${doc.id}`;
}

/**
 * S8-W1: review and send ONE existing document into this conversation.
 *
 * WHAT THIS COMPONENT DOES NOT DO
 * ------------------------------
 * It does not compose the message. Every word the customer will read arrives
 * from the server, produced from the verified Odoo document, and is shown here
 * read-only. There is deliberately no textarea: an editable body would make the
 * panel the author of a customer-facing price, which is exactly what the
 * server-side composer exists to prevent.
 *
 * The idempotency key is derived from the conversation, the document AND the
 * fingerprint of the reviewed text. A double-click therefore replays instead of
 * sending twice, while a genuinely changed document produces a different key
 * rather than silently reusing the old confirmation.
 */
export function SendDocumentReview({
  hint,
  document: doc,
  onClose,
  onSent,
}: {
  hint: ChatwootContextHint;
  document: Customer360Snapshot['documents'][number];
  onClose: () => void;
  onSent: (key: string, outcome: SendOutcome) => void;
}) {
  const [phase, setPhase] = useState<SendPhase>({ kind: 'previewing' });
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    fetch('/api/isola-360/actions/send-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hint, documentId: doc.id, documentKind: doc.kind, preview: true }),
    })
      .then(async (response) => {
        const result = await response.json();
        if (!live) return;
        if (result?.preview && typeof result.body === 'string') {
          setPhase({ kind: 'reviewing', body: result.body, fingerprint: result.fingerprint });
        } else {
          setPhase({ kind: 'refused', detail: result?.detail ?? result?.error ?? 'This document cannot be sent.' });
        }
      })
      .catch(() => { if (live) setPhase({ kind: 'refused', detail: 'Could not prepare the message. Nothing was sent.' }); });
    return () => { live = false; };
  }, [hint, doc.id, doc.kind]);

  async function confirmSend(body: string, fingerprint: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: 'sending', body });
    try {
      const response = await fetch('/api/isola-360/actions/send-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hint,
          documentId: doc.id,
          documentKind: doc.kind,
          previewFingerprint: fingerprint,
          idempotencyKey: `s8w1:${documentKey(hint, doc)}:${fingerprint.slice(0, 16)}`,
        }),
      });
      const result = await response.json();
      const outcome: SendOutcome = {
        // Never inferred from res.ok. Exactly one lifecycle state carries success.
        success: result?.success === true,
        label: result?.label ?? 'Not sent',
        detail: result?.detail ?? result?.error ?? 'No result was returned.',
        operationId: result?.operationId ?? null,
        lifecycle: typeof result?.lifecycle === 'string' ? result.lifecycle : 'unknown',
        // Default FALSE on anything unrecognised: an absent proof is not a proof.
        readbackProven: result?.readbackProven === true,
      };
      setPhase({ kind: 'settled', outcome });
      onSent(documentKey(hint, doc), outcome);
    } catch {
      setPhase({ kind: 'refused', detail: 'The request did not complete, so it is not known whether the message was sent. Re-open to check the conversation before retrying.' });
    } finally {
      inFlight.current = false;
    }
  }

  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Send ${doc.reference} to the customer`}>
    <section className={styles.reviewCard}>
      <span className={styles.eyebrow}>Send to customer</span>
      <h2>{doc.reference}</h2>

      <dl className={styles.reviewFacts}>
        <div><dt>Document</dt><dd>{doc.kind} {doc.reference}</dd></div>
        <div><dt>Amount</dt><dd>{formatMoney(doc.total, doc.currency)}</dd></div>
        <div><dt>Conversation</dt><dd>#{hint.conversationDisplayIdHint}</dd></div>
        <div><dt>Delivered by</dt><dd>The channel that owns this conversation</dd></div>
      </dl>

      {phase.kind === 'previewing' && <p className={styles.copyHint}>Preparing the message from the Odoo record…</p>}

      {phase.kind === 'refused' && <p className={styles.effectNote}>{phase.detail}</p>}

      {(phase.kind === 'reviewing' || phase.kind === 'sending') && <>
        <span className={styles.replyLabel}>This exact message will be sent to the customer</span>
        <pre className={styles.replyBox}>{phase.body}</pre>
        <p className={styles.effectNote}>
          Sending posts this as a visible reply in conversation #{hint.conversationDisplayIdHint}. It does not change anything in Odoo, and it cannot be unsent.
        </p>
        {/*
          F21. This effect was real before it was ever stated: the message is
          posted with an agent credential, which Chatwoot and our own webhook
          cannot tell apart from a human agent typing a reply, so the
          conversation moves to human handling and the assistant stops. The
          handover is CORRECT — a person sending a business document should own
          the reply that comes back — but it was happening silently, which is
          the defect. It is disclosed here, before the click, not discovered
          afterwards when a customer's question goes unanswered.
        */}
        <p className={styles.effectNote}>
          <strong>This also moves the conversation to you.</strong> The AI assistant stops replying
          in conversation #{hint.conversationDisplayIdHint} once you send, so the customer’s next
          message is yours to answer.
        </p>
      </>}

      {phase.kind === 'settled' && <p className={phase.outcome.success ? styles.copyHint : styles.effectNote}>
        <strong>{phase.outcome.label}</strong> — {phase.outcome.detail}
        {phase.outcome.operationId && <><br /><small>Reference {phase.outcome.operationId}</small></>}
      </p>}

      <div className={styles.reviewActions}>
        {phase.kind === 'reviewing' && <button className={styles.primaryBtn} onClick={() => confirmSend(phase.body, phase.fingerprint)}>
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

export function Customer360App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [tab, setTab] = useState<'overview' | 'sales' | 'billing' | 'support'>('overview');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<Customer360Snapshot['documents'][number] | null>(null);
  /** Keyed by conversation+document, so a sent badge cannot land on a sibling row. */
  const [sent, setSent] = useState<Record<string, SendOutcome>>({});

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const parsed = parseChatwootContext(event.data);
      if (parsed.ok) loadSnapshot(parsed.hint, setPhase);
    };
    window.addEventListener('message', listener);
    window.parent?.postMessage(CHATWOOT_FETCH_INFO_REQUEST, '*');
    return () => window.removeEventListener('message', listener);
  }, []);

  if (phase.kind === 'waiting' || phase.kind === 'loading') {
    return <main className={styles.shell}><div className={styles.loading}>Loading the customer workspace…</div></main>;
  }
  if (phase.kind === 'message') {
    return <main className={styles.shell}><section className={styles.notice}><h1>{phase.title}</h1><p>{phase.body}</p>{phase.retry && <button onClick={() => loadSnapshot(phase.retry!, setPhase)}>Try again</button>}</section></main>;
  }

  const { snapshot } = phase;
  const quotations = snapshot.documents.filter((item) => item.kind === 'quotation');
  const invoices = snapshot.documents.filter((item) => item.kind === 'invoice');
  const recommendation = (() => {
    const overdue = invoices.find((item) => (item.residual ?? 0) > 0);
    if (overdue) return `Confirm whether ${overdue.reference} is the customer’s concern, then review the balance before replying.`;
    if (snapshot.openLoops.length) return `There is already open work for this customer. Review it before creating a duplicate.`;
    return 'Confirm the request, then use the customer history to choose the next action.';
  })();

  return <main className={styles.shell}>
    <header className={styles.customerBand}>
      <div><span className={styles.eyebrow}>Verified Odoo customer</span><h1>{snapshot.customer.name}</h1><p>{snapshot.customer.phone ?? 'No phone'} · {snapshot.customer.email ?? 'No email'}</p></div>
      <div className={styles.pulse}><span>Balance due</span><strong>{formatBalances(snapshot.balances)}</strong><small>{snapshot.balances.length > 1 ? 'Separate currencies — not combined' : `Checked ${new Date(snapshot.verifiedAt).toLocaleTimeString()}`}</small></div>
    </header>

    <section className={styles.request}>
      <div><span className={styles.eyebrow}>Current request</span><p>{snapshot.conversation.currentRequest ?? 'Read the current Chatwoot message and confirm the customer’s intent.'}</p></div>
      <div className={styles.guide}><strong>Suggested next step</strong><p>{recommendation}</p></div>
    </section>

    <RecommendedActionCard snapshot={snapshot} onPrepareReply={() => setReviewOpen(true)} />
    {reviewOpen && <ReplyReview snapshot={snapshot} onClose={() => setReviewOpen(false)} />}
    {sendTarget && <SendDocumentReview
      hint={phase.hint}
      document={sendTarget}
      onClose={() => setSendTarget(null)}
      onSent={(key, outcome) => setSent((prior) => ({ ...prior, [key]: outcome }))}
    />}

    <nav className={styles.tabs} aria-label="Customer workspace">
      {([['overview','360 overview'],['sales','Sales'],['billing','Billing'],['support','Support']] as const).map(([id,label]) => <button key={id} className={tab === id ? styles.activeTab : ''} onClick={() => setTab(id)}>{label}</button>)}
    </nav>

    {tab === 'overview' && <section className={styles.grid}>
      <article className={styles.card}><span className={styles.eyebrow}>Commercial</span><strong>{quotations.length} quotations</strong><p>{invoices.length} invoices · {snapshot.openLoopsAvailable ? `${snapshot.openLoops.filter((x) => x.kind === 'opportunity').length} opportunities` : 'opportunities unavailable'}</p><button onClick={() => setTab('sales')}>Review sales</button></article>
      <article className={styles.card}><span className={styles.eyebrow}>Open loops</span><strong>{snapshot.openLoopsAvailable ? `${snapshot.openLoops.length} items need follow-up` : 'Open work unavailable'}</strong><p>{snapshot.openLoopsAvailable ? (snapshot.openLoops[0]?.title ?? 'No open Odoo work found.') : 'Odoo did not answer for opportunities or tasks. This is not a statement that none exist.'}</p><button onClick={() => setTab('support')}>Review loops</button></article>
      <article className={styles.card}><span className={styles.eyebrow}>Account</span><strong>{formatBalances(snapshot.balances)}</strong><p>Odoo remains the authoritative record.</p><button onClick={() => setTab('billing')}>Review billing</button></article>
    </section>}

    {tab === 'sales' && <DocumentList title="Sales documents" empty="No quotations or orders found." items={snapshot.documents.filter((x) => x.kind !== 'invoice')} hint={phase.hint} sent={sent} onSend={setSendTarget} />}
    {tab === 'billing' && <DocumentList title="Invoices" empty="No customer invoices found." items={invoices} hint={phase.hint} sent={sent} onSend={setSendTarget} />}
    {tab === 'support' && <section className={styles.list}><div className={styles.sectionHead}><div><span className={styles.eyebrow}>Close the loop</span><h2>Open customer work</h2></div><p>Review before creating a duplicate.</p></div>{!snapshot.openLoopsAvailable ? <p className={styles.empty}>Odoo did not answer for opportunities or tasks. Review the customer directly in Odoo before assuming there is no open work.</p> : snapshot.openLoops.length ? snapshot.openLoops.map((loop) => <article className={styles.row} key={`${loop.kind}-${loop.id}`}><div><strong>{loop.title}</strong><p>{loop.kind} · {loop.state ?? 'State unavailable'}</p></div><div><span>{loop.due ?? 'No due date'}</span><button disabled title="Exact Odoo deep link lands in the next slice">Open in Odoo</button></div></article>) : <p className={styles.empty}>No open Odoo work found.</p>}</section>}
  </main>;
}

/**
 * A document is offerable for sending only when the server could actually
 * compose a message for it: a sendable kind, a verified total and a verified
 * currency. Offering a button whose only possible outcome is a refusal is worse
 * than not offering it — the same reasoning the action catalogue applies to
 * actions a role may not perform.
 */
function sendability(item: Customer360Snapshot['documents'][number]): { ok: true } | { ok: false; why: string } {
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

function DocumentList({ title, empty, items, hint, sent, onSend }: {
  title: string;
  empty: string;
  items: Customer360Snapshot['documents'];
  hint: ChatwootContextHint;
  sent: Record<string, SendOutcome>;
  onSend: (item: Customer360Snapshot['documents'][number]) => void;
}) {
  return <section className={styles.list}>
    <div className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>Odoo records</span><h2>{title}</h2></div>
      <p>Review the source record before sending anything.</p>
    </div>
    {items.length ? items.map((item) => {
      const can = sendability(item);
      const outcome = sent[documentKey(hint, item)];
      return <article className={styles.row} key={`${item.kind}-${item.id}`}>
        <div>
          <strong>{item.reference}</strong>
          <p>{item.kind} · {item.paymentState ?? item.state ?? 'State unavailable'}</p>
          {/* Only a proven readback prints as sent. Anything else says what it was. */}
          {outcome && <p className={styles.copyHint}>{sendBadgeText(outcome)}</p>}
        </div>
        <div>
          <span>{formatMoney(item.total, item.currency)}</span>
          {item.odooLink
            ? <a className={styles.rowLink} href={item.odooLink} target="_blank" rel="noopener noreferrer">Open in Odoo</a>
            : <button disabled title="No verified deep link for this record">Open in Odoo</button>}
          {can.ok
            ? <button className={styles.primaryBtn} onClick={() => onSend(item)}>Send to customer</button>
            : <button disabled title={can.why}>Send to customer</button>}
        </div>
      </article>;
    }) : <p className={styles.empty}>{empty}</p>}
  </section>;
}
