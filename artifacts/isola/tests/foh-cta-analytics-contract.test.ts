import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, EVENT_NAMES } from '../lib/foh/analytics';
import { conversionProps } from '../lib/foh/use-cta';
import schema from '../contracts/analytics-schema.json';

const USE_CTA_SOURCE = readFileSync(join(__dirname, '..', 'lib', 'foh', 'use-cta.ts'), 'utf8');

// Regression coverage for DISPATCH-003 F1 and F2.
// These assert against the ACCEPTED contract in contracts/analytics-schema.json — the schema is
// never weakened to make a test pass; the emitted properties are corrected to satisfy it.

const EVENTS = (schema as { events: { name: string; required?: string[]; trigger?: string }[] }).events;
const requiredFor = (n: string) => EVENTS.find((e) => e.name === n)?.required ?? [];

// The props every CTA emits before the fix — what `baseProps` alone contains.
const baseProps = {
  cta: 'cta_demo_business_line',
  offer: 'business_line',
  service: 'business_line',
  assistant: 'sales',
  source: 'web',
  campaign: 'none',
  funnelStage: 'Acquire',
};

describe('analytics contract — required properties are as the schema states', () => {
  it('intent_created requires cta and customerType', () => {
    expect(requiredFor('intent_created')).toEqual(['cta', 'customerType']);
  });
  it('demo_requested requires intentId', () => {
    expect(requiredFor('demo_requested')).toEqual(['intentId']);
  });
  it('support_requested requires customerId', () => {
    expect(requiredFor('support_requested')).toEqual(['customerId']);
  });
});

describe('F1 — the pre-fix property set is rejected by the contract', () => {
  // This is the defect: baseProps carries neither customerType nor intentId, so both events
  // were silently dropped. Successful leads rendered in the UI but vanished from analytics.
  it('rejects intent_created for missing customerType', () => {
    const r = emit('intent_created', { ...baseProps, correlationId: 'cor_1' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('MISSING:customerType');
  });
  it('rejects demo_requested for missing intentId', () => {
    const r = emit('demo_requested', { ...baseProps, correlationId: 'cor_1' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('MISSING:intentId');
  });
});

describe('F1 — conversionProps satisfies the contract for both events', () => {
  const rec = { customerType: 'business', offer: 'business_line', service: 'business_line', assistant: 'sales' };
  const props = conversionProps(rec, baseProps, 'int_abc123', 'cor_abc123');

  it('carries the real customerType from the CTA contract', () => {
    expect(props.customerType).toBe('business');
  });
  it('carries the intentId returned by createIntent', () => {
    expect(props.intentId).toBe('int_abc123');
  });
  it('preserves the correlationId', () => {
    expect(props.correlationId).toBe('cor_abc123');
  });
  it('intent_created now validates', () => {
    expect(emit('intent_created', props).ok).toBe(true);
  });
  it('demo_requested now validates', () => {
    expect(emit('demo_requested', props).ok).toBe(true);
  });
  it('satisfies every schema-required key for both events', () => {
    for (const name of ['intent_created', 'demo_requested']) {
      for (const key of requiredFor(name)) {
        expect(props[key], `${name} requires ${key}`).toBeTruthy();
      }
    }
  });
});

describe('P1 — the wa:* branch could not honestly emit any of its configured events', () => {
  // cta_talk_sales_assistant declares analytics ['cta_click','intent_created','wa_conversation_start']
  // and frontendCalls ['createIntent']; cta_contact_support declares ['cta_click','support_requested']
  // and frontendCalls ['supportRequest']. The old shortcut returned before either adapter ran, then
  // emitted the remaining events against baseProps. Each assertion below is why that was wrong.

  it('wa_conversation_start is NOT in the accepted contract at all', () => {
    expect(EVENTS.find((e) => e.name === 'wa_conversation_start')).toBeUndefined();
  });

  it('emitting wa_conversation_start is dropped as UNKNOWN_EVENT', () => {
    const r = emit('wa_conversation_start', baseProps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('UNKNOWN_EVENT');
  });

  it('intent_created asserts "createIntent success" — emitting it without the adapter is a false event', () => {
    expect(EVENTS.find((e) => e.name === 'intent_created')?.trigger).toBe('createIntent success');
  });

  it('support_requested asserts "supportRequest" and needs a customerId no wa: click can supply', () => {
    expect(EVENTS.find((e) => e.name === 'support_requested')?.trigger).toBe('supportRequest');
    const r = emit('support_requested', baseProps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('MISSING:customerId');
  });

  it('the schema was NOT weakened to let any of them pass', () => {
    // wa_conversation_start must stay absent, and the two real events must keep their required keys.
    expect(EVENT_NAMES).not.toContain('wa_conversation_start');
    expect(requiredFor('intent_created')).toEqual(['cta', 'customerType']);
    expect(requiredFor('support_requested')).toEqual(['customerId']);
  });

  // Source proof. The wa:* branch lives inside a React hook with no runtime signal in this
  // node-environment suite, so it is asserted the same way Screen B proves its forbidden
  // patterns (B21-B23): a statement about code that cannot otherwise be observed.
  // These two FAIL against the pre-fix source and pass after.
  const WA_BRANCH = (() => {
    const start = USE_CTA_SOURCE.indexOf("rec.destination?.startsWith('wa:')");
    expect(start).toBeGreaterThan(-1);
    return USE_CTA_SOURCE.slice(start, start + 900);
  })();

  it('the wa:* branch no longer emits the contract events (no emitAll inside it)', () => {
    expect(WA_BRANCH).not.toMatch(/emitAll\s*\(/);
  });

  it('the wa:* branch no longer returns unconditional success — it gates on a validated contact', () => {
    expect(WA_BRANCH).toMatch(/isValidContact\s*\(\s*opts\.contact\s*\)/);
    expect(WA_BRANCH).toContain('WA_OPENED_NOT_RECORDED');
  });
});

describe('F2 — a planned CTA cannot honestly emit conversion events', () => {
  // The planned branch calls no adapter and stores no contact, so it must not claim enrolment.
  // support_requested is unsatisfiable there by construction: there is no customerId, because
  // no customer record was created. This pins WHY the branch emits nothing beyond cta_click.
  it('support_requested is rejected with only baseProps — no customerId exists', () => {
    const r = emit('support_requested', baseProps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('MISSING:customerId');
  });
  it('cta_click remains valid — it is the one event that is actually true', () => {
    expect(emit('cta_click', baseProps).ok).toBe(true);
  });
});
