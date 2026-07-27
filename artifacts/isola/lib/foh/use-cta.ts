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
    if (opts.planned) {
      emitAll(rec.analytics.filter((e) => e !== 'cta_click'), baseProps);
      return setState({ phase: 'waitlisted', msg: 'You\u2019re on the interest list. This product is not available yet.' });
    }

    // Registry-driven destination: a WhatsApp deep link opens WhatsApp directly and fires
    // only the contract's own configured events (e.g. wa_conversation_start) — no intent call.
    if (rec.destination?.startsWith('wa:')) {
      if (typeof window !== 'undefined') window.open(WA_URL, '_blank', 'noreferrer');
      emitAll(rec.analytics.filter((e) => e !== 'cta_click'), { ...baseProps, correlationId: undefined });
      return setState({ phase: 'success', msg: 'Opening WhatsApp\u2026 a person will pick up the conversation.' });
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
      emitAll(rec.analytics.filter((e) => e !== 'cta_click'), { ...baseProps, correlationId: corr });
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
