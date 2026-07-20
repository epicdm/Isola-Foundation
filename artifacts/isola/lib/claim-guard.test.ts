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
