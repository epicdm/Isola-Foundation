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
  // Slice to the next statement rather than a fixed character window, so adding commentary
  // inside the branch cannot silently shorten what these assertions actually inspect.
  const WA_BRANCH = (() => {
    const start = USE_CTA_SOURCE.indexOf("rec.destination?.startsWith('wa:')");
    const end = USE_CTA_SOURCE.indexOf('const front = rec.frontendCalls[0]');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return USE_CTA_SOURCE.slice(start, end);
  })();

  it('the wa:* branch no longer emits the contract events (no emitAll inside it)', () => {
    expect(WA_BRANCH).not.toMatch(/emitAll\s*\(/);
  });

  it('the wa:* branch no longer returns unconditional success — it gates on a validated contact', () => {
    expect(WA_BRANCH).toMatch(/isValidContact\s*\(\s*opts\.contact\s*\)/);
    expect(WA_BRANCH).toContain('WA_OPENED_NOT_RECORDED');
  });
});

describe('P1 (third instance) — the supportRequest branch no longer emits a rejected event', () => {
  // cta_contact_support declares analytics ['cta_click','support_requested'], but
  // support_requested requires [customerId] and a front-of-house support request is
  // pre-customer: baseProps has none and the adapter returns { stage, channel, ticket }.
  // Emitting it read as instrumented and recorded nothing. main @57b7fb1 emitted nothing here.
  it('support_requested cannot be satisfied by baseProps alone', () => {
    const r = emit('support_requested', baseProps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('MISSING:customerId');
  });

  it('the supportRequest branch contains no emitAll call', () => {
    const start = USE_CTA_SOURCE.indexOf("front === 'supportRequest'");
    expect(start).toBeGreaterThan(-1);
    const branch = USE_CTA_SOURCE.slice(start, USE_CTA_SOURCE.indexOf("front === 'resumeJourney'"));
    expect(branch).not.toMatch(/emitAll\s*\(/);
  });

  it('every emitAll call site supplies props that satisfy the schema', () => {
    // The only surviving emitAll is the createIntent success path, which uses conversionProps.
    const sites = USE_CTA_SOURCE.split('\n').filter(
      (l) =>
        /emitAll\s*\(/.test(l) &&
        !/^\s*(\/\/|\*)/.test(l) && // comments
        !/^\s*function\s+emitAll/.test(l), // the declaration itself
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain('conversionProps(');
  });
});

describe('P1c/P1d — no path confirms success it cannot back', () => {
  const SUPPORT_BRANCH = USE_CTA_SOURCE.slice(
    USE_CTA_SOURCE.indexOf("front === 'supportRequest'"),
    USE_CTA_SOURCE.indexOf("front === 'resumeJourney'"),
  );
  const WA_BRANCH = USE_CTA_SOURCE.slice(
    USE_CTA_SOURCE.indexOf("rec.destination?.startsWith('wa:')"),
    USE_CTA_SOURCE.indexOf("const front = rec.frontendCalls[0]"),
  );

  it('P1c: the supportRequest branch checks the adapter status before confirming', () => {
    // A status:'error' response previously produced "A person will help you on WhatsApp" with no
    // ticket created — and the wa:* fall-through made that reachable for cta_contact_support.
    expect(SUPPORT_BRANCH).toMatch(/r\.status\s*===\s*'error'/);
    // the error branch must come before the success setState
    expect(SUPPORT_BRANCH.indexOf("r.status === 'error'"))
      .toBeLessThan(SUPPORT_BRANCH.indexOf("phase: 'success'"));
  });

  it('P1d: the WhatsApp-only outcome does not use a phase whose renderers ignore state.msg', () => {
    // cta-panel.tsx and assistants/page.tsx both render fixed copy for 'success' and ignore msg.
    expect(WA_BRANCH).toContain('WA_OPENED_NOT_RECORDED');
    expect(WA_BRANCH).not.toMatch(/phase:\s*'success'/);
    expect(WA_BRANCH).toMatch(/phase:\s*'waitlisted'/);
  });

  it('P1d: both renderers display state.msg for the phase actually used', () => {
    const panel = readFileSync(join(__dirname, '..', 'components', 'foh', 'cta-panel.tsx'), 'utf8');
    const assistants = readFileSync(
      join(__dirname, '..', 'app', '(marketing)', 'assistants', 'page.tsx'), 'utf8',
    );
    for (const src of [panel, assistants]) {
      const line = src.split('\n').find((l) => l.includes("state.phase === 'waitlisted'"));
      expect(line, 'renderer must handle the waitlisted phase').toBeTruthy();
      expect(line).toContain('state.msg');
    }
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
