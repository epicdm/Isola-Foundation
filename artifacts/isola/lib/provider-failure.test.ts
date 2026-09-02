import { describe, it, expect } from 'vitest';
import { detectProviderFailure } from './provider-failure';
import { detectEscalationClaim } from './escalation-claim';
import { guardReply, SALES_TENANT_IDS, DEFLECTION } from './claim-guard';

/** The exact text a customer received on WhatsApp, 2026-08-13 17:18:45,
 *  Chatwoot conv 233 msg 2784 — outgoing, non-private, from Foundation's bot. */
const CONV_233_LEAK = `任务执行未完成。
错误：HTTP 402: {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}
错误码：model_call_failed
Run ID：0a4dcdfa-571f-4444-86cb-d7bcc1b1922e`;

/** The latent one: Clawith returns this AS the reply when a cap is exceeded. */
const CAP_NOTICE =
  '⚠️ Daily token usage has reached the limit (506,492/200,000). ' +
  'Please try again tomorrow or ask admin to increase the limit.';

describe('provider-failure containment — the observed leaks', () => {
  it('contains the EXACT text a customer received on 2026-08-13', () => {
    const r = detectProviderFailure(CONV_233_LEAK);
    expect(r.leaks).toBe(true);
    expect(r.rule).toBeTruthy();
  });

  it('contains the daily token-cap notice (latent today, live the moment a cap is set)', () => {
    const r = detectProviderFailure(CAP_NOTICE);
    expect(r.leaks).toBe(true);
    expect(r.rule).toBe('token_quota_notice');
  });

  it('contains the monthly variant too', () => {
    expect(detectProviderFailure(
      '⚠️ Monthly token usage has reached the limit (1,000,000/900,000). Please ask admin to increase the limit.',
    ).leaks).toBe(true);
  });

  it('contains a bare provider error envelope', () => {
    expect(detectProviderFailure('{"error":{"message":"Rate limited","code":"429"}}').leaks).toBe(true);
  });

  it('contains LLM-layer error prefixes', () => {
    expect(detectProviderFailure('[LLM Error] upstream timeout after 120s').leaks).toBe(true);
    expect(detectProviderFailure('[LLM call error] connection reset').leaks).toBe(true);
    expect(detectProviderFailure('model_call_failed').leaks).toBe(true);
  });

  it('contains a leaked run identifier', () => {
    expect(detectProviderFailure('Something went wrong. Run ID: 0a4dcdfa-571f-4444-86cb-d7bcc1b1922e').leaks)
      .toBe(true);
  });
});

describe('provider-failure containment — must NOT fire on real replies', () => {
  const legitimate = [
    'We close at 4:00pm Monday to Friday, and 1:00pm on Saturdays.',
    'Your account balance is EC$45.20. Would you like to top up?',
    'That payment was declined by your bank — you may want to check with them.',
    'I don\'t have that detail here, but I can have a colleague confirm it for you.',
    'Your plan includes 20GB. You have used 18GB, so you are close to the limit.',
    'There was an error on our side with your last order, and we have corrected it.',
    'Sorry — I can\'t process a refund myself. Let me bring in a colleague.',
  ];

  for (const text of legitimate) {
    it(`passes: "${text.slice(0, 48)}..."`, () => {
      expect(detectProviderFailure(text).leaks).toBe(false);
    });
  }

  it('passes empty and non-string input without throwing', () => {
    expect(detectProviderFailure('').leaks).toBe(false);
    expect(detectProviderFailure('   ').leaks).toBe(false);
    expect(detectProviderFailure(undefined as unknown as string).leaks).toBe(false);
  });
});

describe('provider-failure containment — the replacement text is safe', () => {
  it('the deflection passes the claim-guard', () => {
    const salesTenant = [...SALES_TENANT_IDS][0];
    expect(guardReply(DEFLECTION, salesTenant).blocked).toBe(false);
  });

  it('the deflection is not itself detected as a provider failure (no loop)', () => {
    expect(detectProviderFailure(DEFLECTION).leaks).toBe(false);
  });

  it('the deflection promises a handoff in FUTURE tense, so the backstop does not fire on it', () => {
    // The escalation-claim backstop is deliberately tense-bounded: its rules
    // match completed-action claims ("flagged", "notified", "already
    // escalated"), not promises. DEFLECTION says "I'll flag this conversation"
    // — future — so it does not trip, which is correct: a promise is not yet a
    // false claim.
    //
    // What makes the promise TRUE is that brain-provider returns DEFLECTION
    // together with needsHandoff:true. If that pairing is ever split, the
    // customer gets a promise nothing fulfils, and no detector will catch it
    // because none of them fire on future tense. This test is the reminder.
    expect(DEFLECTION.toLowerCase()).toContain("i'll flag this conversation");
    expect(detectEscalationClaim(DEFLECTION).claims).toBe(false);
    // The past-tense form of the same sentence WOULD be caught — proving the
    // boundary is tense and not the wording.
    expect(detectEscalationClaim('I have flagged this conversation for the team.').claims).toBe(true);
  });
});
