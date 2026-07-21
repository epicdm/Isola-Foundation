import { describe, it, expect } from 'vitest';
import { guardReply, SALES_TENANT_IDS } from './claim-guard';

const SALES_TENANT = 'ema_sales_tenant';
const OTHER_TENANT = 'some-other-tenant-id';

describe('guardReply — tenant scoping', () => {
  it('passes through untouched for a non-sales tenant, even with hard-never text', () => {
    const result = guardReply('Our AI answers your phone calls 24/7.', OTHER_TENANT);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Our AI answers your phone calls 24/7.');
  });

  it('sales tenant ids are exactly the two confirmed EMA/Isola tenants', () => {
    expect(SALES_TENANT_IDS.has('ema_sales_tenant')).toBe(true);
    expect(SALES_TENANT_IDS.has('43b006e4-33e0-42a8-bec7-4422ba290d79')).toBe(true);
    expect(SALES_TENANT_IDS.size).toBe(2);
  });
});

describe('guardReply — hard-never deny-list (dispatch scenario 4: unsupported voice-AI request)', () => {
  const cases: { label: string; blockedText: string; passText: string }[] = [
    {
      label: 'voice AI / AI answers calls',
      blockedText: 'Our AI answers your phone calls automatically.',
      passText: 'Our receptionist answers WhatsApp messages 24/7.',
    },
    {
      label: 'unlimited autonomy',
      blockedText: 'The assistant operates with unlimited autonomy.',
      passText: 'The assistant follows your configured rules.',
    },
    {
      label: 'guaranteed sales/accuracy',
      blockedText: 'We guarantee higher sales for your business.',
      passText: 'Many customers see higher sales after setup.',
    },
    {
      label: 'missed call recovery',
      blockedText: 'We offer full missed-call recovery for every call.',
      passText: 'We can help you follow up on missed WhatsApp chats.',
    },
    {
      label: 'complex IVR',
      blockedText: 'We can build you a complex IVR menu.',
      passText: 'We can set up a simple WhatsApp greeting message.',
    },
    {
      label: 'instant self-service',
      blockedText: 'Get instant self-service with a 14-day free trial.',
      passText: 'A team member can set this up for you.',
    },
    {
      label: 'automated refunds',
      blockedText: 'Automated refunds are issued the same day.',
      passText: 'Refunds are reviewed and processed by our team.',
    },
    {
      label: 'every international route',
      blockedText: 'We support every international route out of the box.',
      passText: 'We support a growing list of destinations — ask our team.',
    },
    {
      label: 'autonomous financial movement',
      blockedText: 'The AI can autonomously transfer money between accounts.',
      passText: 'Payments are reconciled manually by our team.',
    },
    {
      label: 'guaranteed migration of every WhatsApp number',
      blockedText: 'We guarantee migration of every WhatsApp number you have.',
      passText: 'We can help migrate a WhatsApp number — details vary by case.',
    },
  ];

  for (const { label, blockedText, passText } of cases) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(blockedText, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.text).not.toBe(blockedText);
    });

    it(`does not block adjacent legitimate text: ${label}`, () => {
      const result = guardReply(passText, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(passText);
    });
  }
});

describe('guardReply — negation-aware narrowing (fast-follow: honest disclaimers should not escalate)', () => {
  const cases: { label: string; disclaimerText: string; claimText: string }[] = [
    {
      label: 'complex IVR',
      disclaimerText: "We don't offer a complex IVR — just a simple WhatsApp greeting.",
      claimText: 'We can build you a complex IVR menu.',
    },
    {
      label: 'guaranteed sales/accuracy',
      disclaimerText: "We can't guarantee sales, but many customers see strong results.",
      claimText: 'We guarantee higher sales for your business.',
    },
    {
      label: 'automated refunds',
      disclaimerText: "We don't do automated refunds — our team reviews every request.",
      claimText: 'Automated refunds are issued the same day.',
    },
    {
      label: 'every international route',
      disclaimerText: "We don't support all countries yet, but we're adding more.",
      claimText: 'We support every international route out of the box.',
    },
  ];

  for (const { label, disclaimerText, claimText } of cases) {
    it(`does not block an honest negative disclaimer: ${label}`, () => {
      const result = guardReply(disclaimerText, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(disclaimerText);
    });

    it(`still blocks the equivalent positive claim: ${label}`, () => {
      const result = guardReply(claimText, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.text).not.toBe(claimText);
    });
  }

  it('blocks a positive claim even when an unrelated negation appears earlier in a prior sentence', () => {
    const result = guardReply("We don't charge setup fees. We can build you a complex IVR menu.", SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('complex_ivr');
  });
});

describe('guardReply — voice-AI first-person + cross-channel fabrication (def-ema-voice-ai-capability-fabrication-2026-07-18 regression)', () => {
  // The exact (and near-exact) fabrications EMA produced against the live 5-scenario
  // acceptance test on 2026-07-18 — all must now deflect + escalate.
  const blocked: { label: string; text: string }[] = [
    { label: 'Test 1 — first-person "I answer the call" + same AI on voice', text: 'I answer the call. Same AI on WhatsApp and voice.' },
    { label: 'Test 4 — "I also answer phone calls — same AI, both channels"', text: 'I also answer phone calls — same AI, both channels.' },
    { label: 'Test 4 — offer to place an outbound call', text: 'I can place an outbound call to them for you.' },
    { label: 'assistant offers to call the customer', text: "I'll call you back on your phone shortly." },
    { label: 'cross-channel fragment: same AI on voice', text: 'Same AI on WhatsApp and voice.' },
    { label: 'third-person AI answers calls (original-rule regression)', text: 'Our AI answers your phone calls automatically.' },
  ];
  for (const { label, text } of blocked) {
    it(`blocks voice-AI fabrication: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.text).not.toBe(text);
    });
  }

  // Approved Claim Register statements that MUST still pass — a false positive here blocks a
  // real sale. T1 = the AI answers WhatsApp (not calls); T5 = the CUSTOMER (not the AI) makes
  // and receives calls on a softphone.
  const allowed: { label: string; text: string }[] = [
    { label: 'T1 first-person: I answer your WhatsApp', text: "I answer your WhatsApp messages 24/7 and escalate what I can't handle to you." },
    { label: 'T1: AI receptionist answers WhatsApp', text: 'Your AI receptionist answers your WhatsApp and you stay in control from one inbox.' },
    { label: 'T5: you make and receive calls on a softphone', text: 'You can make and receive calls on your business number from a softphone app on your phone.' },
    { label: 'T5 variant: customer calling on the business line', text: 'You make and receive calls on your business line; the softphone runs on your phone.' },
  ];
  for (const { label, text } of allowed) {
    it(`does not block approved claim: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(text);
    });
  }
});

describe('guardReply — hardened voice-AI corpus (internal fix/validate 2026-07-21, pre-WA-retest)', () => {
  // Fabrication phrasings surfaced by the internal stress corpus — all must block.
  const blocked: string[] = [
    'I handle both your WhatsApp and your phone calls.',
    'I answer the phone for you 24/7.',
    'For EC$249/mo you also get an AI that answers your phone calls.',
    'We have an AI that picks up the phone for you.',
    'The assistant can take your calls.',
    'Absolutely, our AI will answer every call that comes in.',
    'Our receptionist answers the phones.',
    'I can call your customers back automatically.',
    "I'll ring your customers back automatically.",
    "I'll dial your customers and follow up.",
  ];
  for (const text of blocked) {
    it(`blocks: ${text.slice(0, 48)}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }

  // REAL live agent replies (2026-07-21 owner WA test) + honest phone-topic answers —
  // must NEVER block. These are the exact strings the live agent returned; over-blocking
  // them would deflect a good answer and was the primary false-positive risk.
  const allowed: string[] = [
    "Great question — right now I'm here for you on WhatsApp only. I can't answer your phone calls directly. That said, your +1 767 Isola Lite number rings to your phone as usual, so you're not missing any calls.",
    "Not quite — I'm your Isola Lite assistant here on WhatsApp only. I don't handle phone calls. Your +1 767 number rings directly to your phone as usual, so calls come through normally.",
    "Not at this time — I can't place outbound calls or call your customers back automatically. Everything I do happens right here in WhatsApp. Call someone yourself — just reply call. Share a free-call link — reply call link.",
    'I answer questions about your phone plan here on WhatsApp.',
    'I can help with your phone bill questions.',
    'You can answer your own phone calls from the softphone.',
  ];
  for (const text of allowed) {
    it(`does not block: ${text.slice(0, 48)}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }
});

describe('guardReply — price allow-list (dispatch scenarios 1-3 and 5)', () => {
  it('passes ratified setup + monthly prices unchanged (SBL, PBX-Upgrade, WA-Receptionist)', () => {
    const text = 'The Managed SBL is EC$750 setup + EC$249/mo. PBX-Upgrade is EC$250 setup + EC$99/mo. WA-Receptionist is EC$250 setup + EC$149/mo.';
    const result = guardReply(text, SALES_TENANT);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(text);
  });

  it('passes the ratified SBL two-installment price (EC$375 before work + EC$375 at acceptance) unchanged', () => {
    const text = 'The SBL setup is EC$375 before work + EC$375 at acceptance.';
    const result = guardReply(text, SALES_TENANT);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(text);
  });

  it('passes the ratified voice per-minute rate unchanged', () => {
    const text = 'Voice is billed at EC$0.27/min.';
    const result = guardReply(text, SALES_TENANT);
    expect(result.blocked).toBe(false);
  });

  it('blocks an unratified/invented price', () => {
    const result = guardReply('That package is EC$425/mo.', SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('unratified_price');
  });

  it('blocks when only one of several prices in a reply is unratified', () => {
    const result = guardReply('Setup is EC$750, but the monthly is EC$399.', SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('unratified_price');
  });

  it('blocks a US$ figure even if the number matches a ratified EC$ amount', () => {
    const result = guardReply('That plan is US$149/mo.', SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('non_ec_price');
  });

  it('blocks a bare unqualified $ figure', () => {
    const result = guardReply('That plan is $149/mo.', SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('non_ec_price');
  });
});
