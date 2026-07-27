'use client';
// useCta — single CTA execution path, driven by the registry contract (not hardcoded per-CTA
// logic). destination 'wa:*' opens WhatsApp directly and fires only the contract's own
// analytics events; frontendCalls[0] selects the adapter call otherwise. Never runs
// journeyCalls (qualify/recommend/requestProposal) or provisioningCalls (activate*) on click.
import { useCallback, useState } from 'react';
import { byId } from './cta-registry';
import { emit } from './analytics';
import { IsolaServices } from './service-adapter';
import { WA_URL } from './catalog';

export type CtaPhase = 'idle' | 'loading' | 'validation' | 'error' | 'success' | 'recovery' | 'waitlisted';
export interface CtaState {
  phase: CtaPhase; code?: string; msg?: string; intentId?: string; corr?: string;
  retry?: () => void; resume?: () => Promise<void>; resumeUrl?: string;
}
export interface RunOpts { consent?: boolean; contact?: string; scenario?: string; intentId?: string; planned?: boolean }

const GENERIC_ERROR = 'We couldn\u2019t submit your request. Try again or message EPIC.';

// Digit-normalized phone check (E.164-ish) or plausible email. Rejects placeholders like "wa".
export function isValidContact(v?: string): boolean {
  if (!v) return false;
  const s = v.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  const digits = s.replace(/[^0-9]/g, '');
  return /^\+?[0-9 ()-]+$/.test(s) && digits.length >= 7 && digits.length <= 15;
}
// Normalize a phone to a stable digits-only form so formatting variants share one idempotency key.
export function normalizeContact(v: string): string {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return v.trim().toLowerCase();
  return '+' + v.replace(/[^0-9]/g, '');
}

function emitAll(names: string[], props: Record<string, unknown>) {
  names.forEach((n) => emit(n, props));
}

// F1: the property set emitted for a successful createIntent. Exported so the schema contract
// can be regression-tested directly -- previously these props were assembled inline and the
// omission of customerType/intentId could only be observed as silently dropped analytics.
export function conversionProps(
  rec: { customerType?: unknown; offer?: unknown; service?: unknown; assistant?: unknown },
  baseProps: Record<string, unknown>,
  intentId: string | undefined,
  correlationId: string | undefined,
): Record<string, unknown> {
  return { ...baseProps, customerType: rec.customerType, intentId, correlationId };
}

export function useCta() {
  const [state, setState] = useState<CtaState>({ phase: 'idle' });
  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  const run = useCallback(async (ctaId: string, opts: RunOpts = {}) => {
    const rec = byId(ctaId);
    if (!rec) return setState({ phase: 'error', code: 'NO_CTA', msg: 'Unknown CTA: ' + ctaId });
    const baseProps = { cta: ctaId, offer: rec.offer, service: rec.service, assistant: rec.assistant, source: rec.sourceChannel, campaign: rec.campaign, funnelStage: 'Acquire' };
    emit('cta_click', baseProps);
    if (rec.consentRequired && !opts.consent) return setState({ phase: 'validation', code: 'CONSENT_REQUIRED', msg: 'Please agree to be contacted so EPIC can follow up.' });

    // Planned products never behave like a live sales request — waitlist only, no intent created.
    // F2: this must NOT claim enrolment. Nothing persists a waitlist entry -- the contract
    // exposes no waitlist adapter, opts.contact is neither validated nor stored here, and no
    // call is made. Telling the visitor they were "on the interest list" was false: a visitor
    // who entered details and consented left no usable record anywhere.
    //
    // The contract's remaining events are not emitted either. They describe outcomes that did
    // not occur, and support_requested would in any case be rejected by emit() for a missing
    // customerId. cta_click has already fired above and remains true.
    //
    // Required to make enrolment real: an IsolaServices waitlist adapter that stores the
    // contact and returns a record id. That is a separate authorized packet; until it exists
    // and is proven, this renders the honest-unavailable state.
    if (opts.planned) {
      return setState({
        phase: 'waitlisted',
        code: 'WAITLIST_UNAVAILABLE',
        msg: 'This product isn\u2019t available yet, and we can\u2019t add you to a list yet \u2014 nothing was saved. Message EPIC on WhatsApp and a person will note your interest.',
      });
    }

    // Registry-driven destination: a wa:* deep link opens WhatsApp directly.
    // P1: a wa:* destination must NOT short-circuit the contract's frontendCalls.
    //
    // The previous shortcut returned before any adapter ran, so cta_talk_sales_assistant
    // (frontendCalls: createIntent) stored no intent and cta_contact_support
    // (frontendCalls: supportRequest) created no ticket -- while reporting success. It also
    // emitted the contract's remaining events against baseProps alone, and all three were bad:
    //   intent_created      schema trigger is "createIntent success", required [cta, customerType].
    //                       No intent was created, so emitting it is a FALSE event; it was also
    //                       rejected for missing customerType.
    //   support_requested   schema trigger is "supportRequest", required [customerId]. No request
    //                       was made and no customer exists -- likewise false, and rejected.
    //   wa_conversation_start  is not in contracts/analytics-schema.json at all, so emit()
    //                       returns UNKNOWN_EVENT and drops it.
    // A rejected or false event is worse than no event: it reads as success and records nothing.
    // The schema is NOT weakened to make any of these pass.
    //
    // Opening WhatsApp is a real action, so it still happens and is described as exactly that.
    // The adapter call is honoured whenever its inputs genuinely exist: with a validated contact
    // we fall through to the contracted frontendCalls path below, which creates the real record
    // and emits with the required properties. Without one we do not invent a contact -- we report
    // only what actually happened and record nothing.
    //
    // To make the no-contact case recordable, the wa:* flow needs an adapter that opens a
    // conversation from a WhatsApp deep link without a pre-collected contact and returns an id.
    // No such adapter exists on IsolaServices today; adding one is a separate authorized packet.
    if (rec.destination?.startsWith('wa:')) {
      if (typeof window !== 'undefined') window.open(WA_URL, '_blank', 'noreferrer');
      if (!isValidContact(opts.contact)) {
        return setState({
          phase: 'success',
          code: 'WA_OPENED_NOT_RECORDED',
          msg: 'Opening WhatsApp\u2026 send your message there and a person will pick it up. Nothing was saved on your account \u2014 the WhatsApp conversation itself is the record.',
        });
      }
      // A validated contact exists, so the contracted adapter can and must run: fall through.
    }

    const front = rec.frontendCalls[0] ?? 'createIntent';
    setState({ phase: 'loading' });
    try {
      if (front === 'supportRequest') {
        if (!isValidContact(opts.contact)) return setState({ phase: 'validation', code: 'CONTACT_REQUIRED', msg: 'Enter a real WhatsApp number or email so a person can reach you.' });
        const r = await IsolaServices.supportRequest({ message: 'Support request from ' + ctaId, contact: normalizeContact(opts.contact!) });
        emitAll(rec.analytics.filter((e) => e !== 'cta_click'), baseProps);
        return setState({ phase: 'success', corr: r.correlationId, msg: 'A person will help you on WhatsApp.' });
      }
      if (front === 'resumeJourney') {
        const r = await IsolaServices.resumeJourney({ intentId: opts.intentId ?? 'unknown' });
        return r.status === 'error'
          ? setState({ phase: 'recovery', code: r.code, msg: r.message })
          : setState({ phase: 'success', corr: r.correlationId, resumeUrl: r.data?.resumeUrl });
      }
      // createIntent path requires a real, normalized contact
      if (!isValidContact(opts.contact)) return setState({ phase: 'validation', code: 'CONTACT_REQUIRED', msg: 'Enter a real WhatsApp number or email so EPIC can reach you.' });
      const contact = normalizeContact(opts.contact!);
      const idempotencyKey = ctaId + ':' + contact;
      const payload = {
        cta: ctaId, offer: rec.offer, service: rec.service, assistant: rec.assistant,
        customerType: rec.customerType, existingEpic: rec.existingEpic, campaign: rec.campaign,
        referral: rec.referral, source: rec.sourceChannel, consent: !!opts.consent, contact,
        idempotencyKey, _scenario: opts.scenario,
      };
      const res = await IsolaServices.createIntent(payload);
      const corr = res.correlationId;
      if (res.status === 'error') {
        // eslint-disable-next-line no-console
        console.error('[cta:' + ctaId + ']', res.code, res.message, corr);
        return setState({ phase: 'error', code: res.code, msg: GENERIC_ERROR, corr, retry: () => run(ctaId, opts) });
      }
      const intentId = res.data?.intentId as string;
      // ONLY the CTA's own configured events beyond cta_click (typically intent_created; demo_requested for demo CTAs, etc).
      //
      // F1: baseProps alone carries neither customerType nor intentId, so emit() rejected
      // intent_created (required: cta, customerType) and demo_requested (required: intentId)
      // against contracts/analytics-schema.json. Successful leads rendered in the UI but
      // vanished from conversion analytics and experiment results. Both values are already
      // known here -- rec.customerType is on the CTA contract and intentId is returned by
      // createIntent -- so they are passed through rather than the schema being weakened.
      emitAll(rec.analytics.filter((e) => e !== 'cta_click'), conversionProps(rec, baseProps, intentId, corr));
      setState({
        phase: 'success', intentId, corr,
        resume: async () => { const rr = await IsolaServices.resumeJourney({ intentId }); setState((s) => ({ ...s, resumeUrl: rr.data?.resumeUrl })); },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[cta:' + ctaId + '] network error', e);
      setState({ phase: 'error', code: 'NETWORK', msg: GENERIC_ERROR, retry: () => run(ctaId, opts) });
    }
  }, []);

  return { state, run, reset };
}
