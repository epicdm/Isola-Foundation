'use client';

/**
 * The CHATWOOT container for the Customer 360 cockpit.
 *
 * One of two containers around a single pure view. This one knows about
 * Chatwoot: it performs the `postMessage` handshake to learn which conversation
 * it is embedded in, fetches everything, and hands the view plain props. The
 * portal's container will do the same job with a route param instead of a
 * handshake, and render the identical view.
 *
 * Everything framework- or host-specific lives here on purpose:
 *   · `'use client'`
 *   · the Chatwoot handshake
 *   · every fetch
 *   · the idempotency key, which is keyed to the CONVERSATION so a sent badge
 *     can never land on a sibling row
 *
 * The view knows none of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHATWOOT_FETCH_INFO_REQUEST,
  parseChatwootContext,
  type ChatwootContextHint,
} from '@/lib/customer-360/chatwoot-context';
import type { Customer360Response, Customer360Snapshot } from '@/lib/customer-360/contracts';
import {
  FOLLOW_UP_UNREACHABLE_NOTICE,
  followUpNoticeFor,
} from '@/lib/customer-360/follow-up-notice';
import type { SendOutcome } from '@/lib/customer-360/send-badge';
import {
  CustomerWorkspaceView,
  type NestedPhase,
  type NestedTarget,
  type SendPhase,
  type WorkspaceTab,
} from './workspace-view';
import styles from './customer-360.module.css';

type Document = Customer360Snapshot['documents'][number];

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loading'; hint: ChatwootContextHint }
  // The hint is carried into `ready` because a send must name the exact
  // conversation it is posting into, and that locator must be the one the
  // snapshot was resolved from — never re-derived later from a second message.
  | { kind: 'ready'; snapshot: Customer360Snapshot; hint: ChatwootContextHint }
  | { kind: 'message'; title: string; body: string; retry?: ChatwootContextHint };

/** A key that is stable for one document in one conversation. */
export function documentKey(hint: ChatwootContextHint, doc: Document): string {
  return `${hint.conversationDisplayIdHint}:${doc.kind}:${doc.id}`;
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

export function Customer360App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [tab, setTab] = useState<WorkspaceTab>('overview');
  const [replyOpen, setReplyOpen] = useState(false);
  /** Set only when a record's Message button supplied one; cleared on close
   *  so a later no-prefill open (the identity bar's own Message button)
   *  never inherits a stale record's text. */
  const [replyPrefill, setReplyPrefill] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState<Record<string, SendOutcome>>({});
  /*
    ALL OF THIS STATE LIVES BESIDE `phase`, NOT BELOW IT.
    `phase` is the unmount boundary: every Chatwoot appContext re-broadcast calls
    loadSnapshot, which resets phase to `loading` and unmounts the tree under it.
    Anything held below would be destroyed by a re-broadcast the operator never
    caused.
  */
  const [nested, setNested] = useState<NestedTarget | null>(null);
  const [nestedPhase, setNestedPhase] = useState<NestedPhase>({ kind: 'loading' });
  const [sendDoc, setSendDoc] = useState<Document | null>(null);
  const [sendPhase, setSendPhase] = useState<SendPhase>({ kind: 'previewing' });
  const inFlight = useRef(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  /** Why the last follow-up attempt did not produce a follow-up. Null when the
   *  last attempt succeeded, or when none has been made. */
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);

  /**
   * Writes a REAL mail.activity via the create-followup route, then merges
   * the READBACK-PROVEN row the route returns straight into the held
   * snapshot — no full re-fetch, and nothing added to the list until Odoo
   * has confirmed it exists. Tomorrow's real date and the design's own
   * "Follow up — {name}" wording are computed HERE, not in the pure view.
   *
   * A REFUSAL IS NO LONGER ABSORBED. This handler used to check
   * `result?.ok && result.followUp` and do nothing otherwise, with a comment
   * saying so. That made every refusal the route can return invisible — an
   * unbound tenant, an unreachable Odoo, a failed readback — and, with no
   * .catch() on the chain, a thrown request was an unhandled rejection and the
   * same silence. The operator pressed a button and nothing at all happened,
   * which they cannot even report. followUpNoticeFor() decides the words; the
   * three cases it separates are documented in that module.
   */
  const createFollowUp = useCallback(() => {
    if (phase.kind !== 'ready' || creatingFollowUp) return;
    const { snapshot } = phase;
    setCreatingFollowUp(true);
    // Clear the previous attempt's notice: a stale refusal sitting over a fresh
    // attempt is its own small lie.
    setFollowUpNotice(null);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dueDate = tomorrow.toISOString().slice(0, 10);
    fetch('/api/isola-360/actions/create-followup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: snapshot.customer.id,
        note: `Follow up — ${snapshot.customer.name}`,
        dueDate,
      }),
    })
      .then(async (response) => response.json())
      .then((result) => {
        const notice = followUpNoticeFor(result);
        if (notice === null) {
          setPhase((p) => p.kind === 'ready'
            ? { ...p, snapshot: { ...p.snapshot, followUps: [...p.snapshot.followUps, result.followUp] } }
            : p);
          return;
        }
        // The customer is still fully usable — only the one write did not
        // happen — so this is a notice beside the workspace, not a page that
        // replaces it. The button re-enables either way.
        setFollowUpNotice(notice);
      })
      .catch(() => {
        // The request never came back. Whether a follow-up was created is
        // genuinely unknown, and the notice says exactly that rather than
        // claiming nothing happened.
        setFollowUpNotice(FOLLOW_UP_UNREACHABLE_NOTICE);
      })
      .finally(() => setCreatingFollowUp(false));
  }, [phase, creatingFollowUp]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const parsed = parseChatwootContext(event.data);
      if (parsed.ok) loadSnapshot(parsed.hint, setPhase);
    };
    window.addEventListener('message', listener);
    window.parent?.postMessage(CHATWOOT_FETCH_INFO_REQUEST, '*');
    return () => window.removeEventListener('message', listener);
  }, []);

  /** Fetch the opened object. Refuses to render a guess on any failure. */
  useEffect(() => {
    if (!nested || phase.kind !== 'ready') return;
    let live = true;
    setNestedPhase({ kind: 'loading' });
    fetch('/api/isola-360/objects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hint: phase.hint, objectId: nested.id, objectKind: nested.kind }),
    })
      .then(async (response) => {
        const result = await response.json();
        if (!live) return;
        if (result?.state === 'ready') setNestedPhase({ kind: 'ready', detail: result.detail });
        else setNestedPhase({ kind: 'message', text: result?.message ?? 'This record could not be opened.' });
      })
      .catch(() => {
        if (live) setNestedPhase({ kind: 'message', text: 'This record could not be opened, so nothing is shown for it.' });
      });
    return () => { live = false; };
  }, [nested, phase]);

  /** Preview the exact text, server-composed, the moment the dialog opens. */
  useEffect(() => {
    if (!sendDoc || phase.kind !== 'ready') return;
    let live = true;
    setSendPhase({ kind: 'previewing' });
    fetch('/api/isola-360/actions/send-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hint: phase.hint, documentId: sendDoc.id, documentKind: sendDoc.kind, preview: true }),
    })
      .then(async (response) => {
        const result = await response.json();
        if (!live) return;
        if (result?.preview && typeof result.body === 'string') {
          setSendPhase({ kind: 'reviewing', body: result.body, fingerprint: result.fingerprint });
        } else {
          setSendPhase({ kind: 'refused', detail: result?.detail ?? result?.error ?? 'This document cannot be sent.' });
        }
      })
      .catch(() => { if (live) setSendPhase({ kind: 'refused', detail: 'Could not prepare the message. Nothing was sent.' }); });
    return () => { live = false; };
  }, [sendDoc, phase]);

  const confirmSend = useCallback(async (body: string, fingerprint: string) => {
    if (phase.kind !== 'ready' || !sendDoc || inFlight.current) return;
    inFlight.current = true;
    setSendPhase({ kind: 'sending', body });
    try {
      const response = await fetch('/api/isola-360/actions/send-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hint: phase.hint,
          documentId: sendDoc.id,
          documentKind: sendDoc.kind,
          previewFingerprint: fingerprint,
          idempotencyKey: `s8w1:${documentKey(phase.hint, sendDoc)}:${fingerprint.slice(0, 16)}`,
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
        // Present only on a proven replay. Shown, not asserted.
        priorReadback: result?.priorReadback ?? null,
      };
      setSendPhase({ kind: 'settled', outcome });
      setSent((prior) => ({ ...prior, [documentKey(phase.hint, sendDoc)]: outcome }));
    } catch {
      setSendPhase({
        kind: 'refused',
        detail: 'The request did not complete, so it is not known whether the message was sent. Re-open to check the conversation before retrying.',
      });
    } finally {
      inFlight.current = false;
    }
  }, [phase, sendDoc]);

  if (phase.kind === 'waiting' || phase.kind === 'loading') {
    return <main className={styles.shell}><div className={styles.loading}>Loading the customer workspace…</div></main>;
  }
  if (phase.kind === 'message') {
    return <main className={styles.shell}><section className={styles.notice}>
      <h1>{phase.title}</h1>
      <p>{phase.body}</p>
      {phase.retry && <button onClick={() => loadSnapshot(phase.retry!, setPhase)}>Try again</button>}
    </section></main>;
  }

  const hint = phase.hint;

  return <>
    {followUpNotice && (
      // Beside the workspace, never instead of it: the customer is still fully
      // readable and every other action still works. `role="status"` so a
      // screen reader announces it without stealing focus.
      <section className={styles.notice} role="status">
        <p>{followUpNotice}</p>
        <button onClick={() => setFollowUpNotice(null)}>Dismiss</button>
      </section>
    )}
    <CustomerWorkspaceView
      snapshot={phase.snapshot}
      tab={tab}
      onTabChange={setTab}
      nested={nested ? { target: nested, phase: nestedPhase } : null}
      onOpenObject={setNested}
      onCloseObject={() => setNested(null)}
      outcomeFor={(doc) => sent[documentKey(hint, doc)]}
      send={sendDoc ? { doc: sendDoc, phase: sendPhase } : null}
      onSendOpen={setSendDoc}
      onSendConfirm={confirmSend}
      onSendClose={() => setSendDoc(null)}
      replyOpen={replyOpen}
      replyPrefill={replyPrefill}
      onReplyOpen={(prefillText) => { setReplyPrefill(prefillText); setReplyOpen(true); }}
      onReplyClose={() => { setReplyOpen(false); setReplyPrefill(undefined); }}
      onCreateFollowUp={createFollowUp}
      creatingFollowUp={creatingFollowUp}
      destinationLabel={`conversation #${hint.conversationDisplayIdHint}`}
    />
  </>;
}
