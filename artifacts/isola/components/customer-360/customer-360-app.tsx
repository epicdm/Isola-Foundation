'use client';

import { useEffect, useState } from 'react';
import {
  CHATWOOT_FETCH_INFO_REQUEST,
  parseChatwootContext,
  type ChatwootContextHint,
} from '@/lib/customer-360/chatwoot-context';
import type { Customer360Response, Customer360Snapshot } from '@/lib/customer-360/contracts';
import styles from './customer-360.module.css';

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loading'; hint: ChatwootContextHint }
  | { kind: 'ready'; snapshot: Customer360Snapshot }
  | { kind: 'message'; title: string; body: string; retry?: ChatwootContextHint };

const money = new Intl.NumberFormat('en-DM', { style: 'currency', currency: 'XCD' });

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
      if (result.state === 'ready') setPhase({ kind: 'ready', snapshot: result.snapshot });
      else setPhase({ kind: 'message', title: 'Customer 360 needs attention', body: result.message, retry: hint });
    })
    .catch((error) => {
      setPhase({ kind: 'message', title: 'Customer 360 is unavailable', body: error instanceof Error ? error.message : 'Try again.', retry: hint });
    });
}

export function Customer360App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [tab, setTab] = useState<'overview' | 'sales' | 'billing' | 'support'>('overview');

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
      <div className={styles.pulse}><span>Balance due</span><strong>{snapshot.balanceDue == null ? '—' : money.format(snapshot.balanceDue)}</strong><small>Checked {new Date(snapshot.verifiedAt).toLocaleTimeString()}</small></div>
    </header>

    <section className={styles.request}>
      <div><span className={styles.eyebrow}>Current request</span><p>{snapshot.conversation.currentRequest ?? 'Read the current Chatwoot message and confirm the customer’s intent.'}</p></div>
      <div className={styles.guide}><strong>Suggested next step</strong><p>{recommendation}</p></div>
    </section>

    <nav className={styles.tabs} aria-label="Customer workspace">
      {([['overview','360 overview'],['sales','Sales'],['billing','Billing'],['support','Support']] as const).map(([id,label]) => <button key={id} className={tab === id ? styles.activeTab : ''} onClick={() => setTab(id)}>{label}</button>)}
    </nav>

    {tab === 'overview' && <section className={styles.grid}>
      <article className={styles.card}><span className={styles.eyebrow}>Commercial</span><strong>{quotations.length} quotations</strong><p>{invoices.length} invoices · {snapshot.openLoops.filter((x) => x.kind === 'opportunity').length} opportunities</p><button onClick={() => setTab('sales')}>Review sales</button></article>
      <article className={styles.card}><span className={styles.eyebrow}>Open loops</span><strong>{snapshot.openLoops.length} items need follow-up</strong><p>{snapshot.openLoops[0]?.title ?? 'No open Odoo work found.'}</p><button onClick={() => setTab('support')}>Review loops</button></article>
      <article className={styles.card}><span className={styles.eyebrow}>Account</span><strong>{snapshot.balanceDue ? money.format(snapshot.balanceDue) : 'No posted balance'}</strong><p>Odoo remains the authoritative record.</p><button onClick={() => setTab('billing')}>Review billing</button></article>
    </section>}

    {tab === 'sales' && <DocumentList title="Sales documents" empty="No quotations or orders found." items={snapshot.documents.filter((x) => x.kind !== 'invoice')} />}
    {tab === 'billing' && <DocumentList title="Invoices" empty="No customer invoices found." items={invoices} />}
    {tab === 'support' && <section className={styles.list}><div className={styles.sectionHead}><div><span className={styles.eyebrow}>Close the loop</span><h2>Open customer work</h2></div><p>Review before creating a duplicate.</p></div>{snapshot.openLoops.length ? snapshot.openLoops.map((loop) => <article className={styles.row} key={`${loop.kind}-${loop.id}`}><div><strong>{loop.title}</strong><p>{loop.kind} · {loop.state ?? 'State unavailable'}</p></div><div><span>{loop.due ?? 'No due date'}</span><button disabled title="Exact Odoo deep link lands in the next slice">Open in Odoo</button></div></article>) : <p className={styles.empty}>No open Odoo work found.</p>}</section>}
  </main>;
}

function DocumentList({ title, empty, items }: { title: string; empty: string; items: Customer360Snapshot['documents'] }) {
  return <section className={styles.list}><div className={styles.sectionHead}><div><span className={styles.eyebrow}>Odoo records</span><h2>{title}</h2></div><p>Review the source record before sending anything.</p></div>{items.length ? items.map((item) => <article className={styles.row} key={`${item.kind}-${item.id}`}><div><strong>{item.reference}</strong><p>{item.kind} · {item.paymentState ?? item.state ?? 'State unavailable'}</p></div><div><span>{item.total == null ? '—' : money.format(item.total)}</span><button disabled title="Send/review action lands in the next slice">Review</button></div></article>) : <p className={styles.empty}>{empty}</p>}</section>;
}
