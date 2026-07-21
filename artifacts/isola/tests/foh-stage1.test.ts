import { describe, it, expect } from 'vitest';
import Registry from '../contracts/cta-registry.js';
import Adapter from '../contracts/service-adapter.js';
import schema from '../contracts/analytics-schema.json';
import { REQUIRED_METHODS, assertAdapter, IsolaServices } from '../lib/foh/service-adapter';
import { isValidContact } from '../lib/foh/use-cta';

const S: any = IsolaServices;
const CTAS = (Registry as any).CTAS as any[];
const byId = (Registry as any).byId as (id: string) => any;

describe('service-adapter bridge', () => {
  it('exposes every required method at runtime', () => {
    for (const m of REQUIRED_METHODS) expect(typeof (S as any)[m]).toBe('function');
  });
  it('assertAdapter throws /createIntent/ when createIntent is undefined', () => {
    expect(() => assertAdapter({ ...IsolaServices, createIntent: undefined } as any)).toThrow(/createIntent/);
  });
  it('assertAdapter passes for the real bridge', () => {
    expect(() => assertAdapter(IsolaServices)).not.toThrow();
  });
});

describe('contract drift — CTA registry', () => {
  const EXPECT = [
    'cta_business_line','cta_hosted_pbx','cta_connect_pbx','cta_personal_line','cta_add_receptionist',
    'cta_add_sales_assistant','cta_upgrade_epic_pbx','cta_build_smart_front_desk','cta_talk_sales_assistant',
    'cta_request_demo','cta_apply','cta_resume_setup','cta_contact_support',
  ];
  it('has exactly the expected CTA ids', () => {
    expect(CTAS.map((c) => c.id).sort()).toEqual([...EXPECT].sort());
  });
  it('every CTA has label, sourcePage, phase-split calls and analytics', () => {
    for (const c of CTAS) {
      expect(c.label).toBeTruthy();
      expect(c.sourcePage).toBeTruthy();
      expect(Array.isArray(c.frontendCalls)).toBe(true);
      expect(Array.isArray(c.journeyCalls)).toBe(true);
      expect(Array.isArray(c.provisioningCalls)).toBe(true);
      expect(c.analytics.length).toBeGreaterThan(0);
    }
  });
  it('marketing click never provisions: frontendCalls exclude activate*/qualify/recommend', () => {
    for (const c of CTAS) for (const call of c.frontendCalls) expect(['createIntent','resumeJourney','supportRequest']).toContain(call);
  });
  it('communications-only CTAs carry assistant:null', () => {
    for (const id of ['cta_business_line','cta_hosted_pbx','cta_connect_pbx','cta_personal_line']) expect(byId(id).assistant).toBeNull();
  });
});

describe('contract drift — analytics schema', () => {
  it('exposes 27 events with names + required arrays', () => {
    const events = (schema as any).events as any[];
    expect(events.length).toBe(27);
    for (const e of events) { expect(e.name).toBeTruthy(); expect(Array.isArray(e.required ?? [])).toBe(true); }
  });
});

describe('contact validation (isValidContact)', () => {
  it.each([
    ['wa', false],
    ['x', false],
    ['', false],
    ['+1 767 123 4567', true],
    ['17671234567', true],
    ['(767) 123-4567', true],
    ['me@example.com', true],
    ['a@b.co', true],
  ])('isValidContact(%j) === %s', (input, expected) => {
    expect(isValidContact(input as string)).toBe(expected);
  });
});

describe('CTA journey semantics (mock adapter)', () => {
  it('createIntent success returns intent + correlation', async () => {
    const r = await S.createIntent({ cta: 'cta_business_line', service: 'business_line', assistant: null, customerType: 'business', consent: true, contact: '+17671234567' });
    expect(r.status).toBe('success');
    expect(r.data.intentId).toBeTruthy();
    expect(r.correlationId).toBeTruthy();
  });
  it('duplicate submission is idempotent (same intentId)', async () => {
    const p = { cta: 'cta_business_line', service: 'business_line', customerType: 'business', consent: true, contact: '+17670000001', idempotencyKey: 'cta_business_line:+17670000001' };
    const a = await S.createIntent(p); const b = await S.createIntent(p);
    expect(b.data.duplicate).toBe(true);
    expect(b.data.intentId).toBe(a.data.intentId);
  });
  it('service_error is a hard error: SERVICE_UNAVAILABLE + retry + correlationId (never pending)', async () => {
    const r = await S.createIntent({ cta: 'cta_hosted_pbx', service: 'hosted_pbx', customerType: 'business', consent: true, contact: '+17671112222', _scenario: 'service_error' });
    expect(r.status).toBe('error');
    expect(r.code).toBe('SERVICE_UNAVAILABLE');
    expect(r.recovery).toBe('retry');
    expect(r.correlationId).toBeTruthy();
    expect(r.status).not.toBe('pending');
  });
});
