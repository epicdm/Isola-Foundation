'use client';
// useCta — single CTA execution path. A marketing-page click runs the contract's
// frontendCalls ONLY (createIntent / resumeJourney / supportRequest). It never runs
// journeyCalls (qualify/recommend/requestProposal) or provisioningCalls (activate*),
// so it cannot activate a service/assistant or claim qualification that did not happen.
import { useCallback, useState } from 'react';
import { byId } from './cta-registry';
import { emit } from './analytics';
import { IsolaServices } from './service-adapter';

export type CtaPhase = 'idle' | 'loading' | 'validation' | 'error' | 'success' | 'recovery';
export interface CtaState {
  phase: CtaPhase; code?: string; msg?: string; intentId?: string; corr?: string;
  retry?: () => void; resume?: () => Promise<void>; resumeUrl?: string;
}
export interface RunOpts { consent?: boolean; contact?: string; scenario?: string; intentId?: string }

// Accept a real phone (+digits, >=7) or a plausible email. Rejects placeholders like "wa".
export function isValidContact(v?: string): boolean {
  if (!v) return false;
  const s = v.trim();
  if (/^\+?[0-9(][0-9 ()-]{6,}$/.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  return false;
}

export function useCta() {
  const [state, setState] = useState<CtaState>({ phase: 'idle' });
  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  const run = useCallback(async (ctaId: string, opts: RunOpts = {}) => {
    const rec = byId(ctaId);
    if (!rec) return setState({ phase: 'error', code: 'NO_CTA', msg: 'Unknown CTA: ' + ctaId });
    emit('cta_click', { cta: ctaId, offer: rec.offer, service: rec.service, assistant: rec.assistant, source: rec.sourceChannel, campaign: rec.campaign, funnelStage: 'Acquire' });
    if (rec.consentRequired && !opts.consent) return setState({ phase: 'validation', code: 'CONSENT_REQUIRED', msg: 'Please agree to be contacted so EPIC can follow up.' });

    const front = rec.frontendCalls[0] ?? 'createIntent';
    setState({ phase: 'loading' });
    try {
      if (front === 'supportRequest') {
        const r = await IsolaServices.supportRequest({ message: 'Support request from ' + ctaId, contact: opts.contact });
        return setState({ phase: 'success', corr: r.correlationId, msg: 'A person will help you on WhatsApp.' });
      }
      if (front === 'resumeJourney') {
        const r = await IsolaServices.resumeJourney({ intentId: opts.intentId ?? 'unknown' });
        return r.status === 'error'
          ? setState({ phase: 'recovery', code: r.code, msg: r.message })
          : setState({ phase: 'success', corr: r.correlationId, resumeUrl: r.data?.resumeUrl });
      }
      // createIntent path requires a real contact
      if (!isValidContact(opts.contact)) return setState({ phase: 'validation', code: 'CONTACT_REQUIRED', msg: 'Enter a real WhatsApp number or email so EPIC can reach you.' });
      const idempotencyKey = ctaId + ':' + opts.contact;
      const payload = {
        cta: ctaId, offer: rec.offer, service: rec.service, assistant: rec.assistant,
        customerType: rec.customerType, existingEpic: rec.existingEpic, campaign: rec.campaign,
        referral: rec.referral, source: rec.sourceChannel, consent: !!opts.consent, contact: opts.contact!,
        idempotencyKey, _scenario: opts.scenario,
      };
      const res = await IsolaServices.createIntent(payload);
      const corr = res.correlationId;
      if (res.status === 'error') {
        emit('lead_lost', { intentId: 'n/a', reason: res.code ?? 'error' });
        return setState({ phase: 'error', code: res.code, msg: res.message, corr, retry: () => run(ctaId, opts) });
      }
      const intentId = res.data?.intentId as string;
      // ONLY intent_created here. qualification_started belongs to the sales-assisted qualify() step.
      emit('intent_created', { cta: ctaId, customerType: rec.customerType, service: rec.service, assistant: rec.assistant, correlationId: corr });
      setState({
        phase: 'success', intentId, corr,
        resume: async () => { const rr = await IsolaServices.resumeJourney({ intentId }); setState((s) => ({ ...s, resumeUrl: rr.data?.resumeUrl })); },
      });
    } catch (e) {
      setState({ phase: 'error', code: 'NETWORK', msg: String(e), retry: () => run(ctaId, opts) });
    }
  }, []);

  return { state, run, reset };
}
