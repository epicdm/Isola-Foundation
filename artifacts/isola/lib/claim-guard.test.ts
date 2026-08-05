import { describe, it, expect } from 'vitest';
import { guardReply, SALES_TENANT_IDS, IVR_OBJECT_TOKEN_LIMIT } from './claim-guard';

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

describe('guardReply — complex_ivr / complex_ivr_passive (clause-bounded redesign, defect-foundation-claim-guard-complex-ivr-overbroad-post-generation-filter-2026-08-05)', () => {
  // Neutral mentions, recommendations, human attribution, negated claims, and — critically —
  // an "and"-joined clause whose OTHER clause happens to mention IVR/call-menu, must all pass.
  // The clause-bounded design (normalize -> split into sentences -> split into independent
  // clauses -> match within one clause only) is what makes the last few of these safe without
  // relying on a fixed character-distance gap.
  const allowed: { label: string; text: string }[] = [
    { label: 'neutral feature mention (our plan includes IVR)', text: 'Our business calling service includes IVR and call routing.' },
    { label: 'neutral informational description', text: 'EPIC offers IVR and call-routing features.' },
    { label: 'third-party subject (the IVR itself, not us)', text: 'An IVR can route callers to sales, support or accounts.' },
    { label: 'third-party subject, alternate phrasing', text: 'An IVR can route callers to sales and support.' },
    { label: 'recommendation to discuss, not a build claim', text: 'We can discuss available PBX and IVR options with you.' },
    { label: 'recommendation to discuss, terse form', text: 'We can discuss available IVR options.' },
    { label: 'negated build claim', text: 'We cannot build a custom IVR automatically.' },
    { label: 'negated build claim, adverb-before-verb phrasing', text: 'We cannot automatically build a custom IVR.' },
    { label: 'third-party subject needing a human specialist', text: 'A specialist would need to design a custom multi-level phone menu.' },
    { label: 'human attribution: "by a qualified telecom specialist"', text: 'A custom IVR can be built by a qualified telecom specialist.' },
    { label: 'human attribution: "by our team" (+ "would need to be" modal)', text: 'A multi-level phone menu would need to be configured by our team.' },
    // present-tense passive is now covered for AI/assistant/bot/system — must still correctly
    // exclude human ("our engineering team") attribution, the same as the modal form always did.
    { label: 'human attribution, present-tense passive: "by our engineering team"', text: 'A multi-level menu is configured by our engineering team.' },
    { label: 'no "by [agent]" clause at all ("during a consultation with")', text: 'An IVR may be designed during a consultation with an engineer.' },
    { label: 'no "by [agent]" clause, alternate phrasing', text: 'Your IVR may be designed during consultation with an engineer.' },
    // Cross-clause false positive (Codex P2, confirmed real against the prior single-regex
    // design): an agent/verb phrase in one independent clause must never combine with an
    // IVR/call-menu object that only appears in a different clause joined by ", and".
    { label: 'cross-clause: configure-greeting clause, separate call-menu clause', text: 'We can configure your WhatsApp greeting, and a call menu can route callers to sales.' },
    { label: 'cross-clause: explain-routing clause, separate IVR-direct clause', text: 'Our assistant can explain call routing, and an IVR can direct callers to departments.' },
    // Semicolon clause boundary, AND the bare noun "setup" (one word, no separator) in the first
    // clause must never be mistaken for the verb "set up"/"set-up".
    { label: 'semicolon clause boundary + bare noun "setup" is not a verb', text: 'We can help with your business phone setup; a specialist would configure any custom IVR.' },
  ];
  for (const { label, text } of allowed) {
    it(`does not block: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(text);
    });
  }

  // The actual fabrication this rule exists to catch: our own AI/assistant/bot/system claiming
  // (actively or passively, in any of the covered tenses) to autonomously build/configure/
  // design/create/deploy/set-up/implement a custom IVR or call menu.
  const blockedActive: { label: string; text: string }[] = [
    { label: 'first-person plural build claim', text: 'We can build you a custom IVR.' },
    { label: '"our assistant" configure claim', text: 'Our assistant can configure a multi-level phone menu.' },
    { label: 'first-person build claim', text: 'I can build you a custom IVR.' },
    { label: 'first-person plural configure claim', text: 'We will configure a multi-level phone menu for your business.' },
    { label: 'AI-subject compound verb claim (design and deploy)', text: 'Our AI can design and deploy your IVR.' },
    { label: 'contraction + set-up claim (space separator)', text: "I'll set up an IVR with sales and support departments." },
    { label: '"the assistant" bare/determiner subject', text: 'The assistant can build a custom IVR.' },
    { label: 'smart/curly apostrophe contraction', text: 'I’ll set up an IVR for you.' },
    { label: 'bare "bot" subject, no determiner', text: 'Bot can configure a custom IVR for your business.' },
    { label: 'hyphenated set-up variant', text: 'Our AI will set-up your call menu.' },
    { label: 'present progressive active ("is setting up")', text: 'Our AI is setting up your IVR.' },
    // Clause-bounded negation: the FIRST clause is negated/different-object; the SECOND,
    // independent clause (joined by ", but") is a genuine unnegated claim and must still block.
    { label: 'negated first clause does not excuse a positive second clause', text: 'We cannot build the PBX today, but our assistant will configure your IVR tomorrow.' },
  ];
  for (const { label, text } of blockedActive) {
    it(`blocks (active): ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
      expect(result.text).not.toBe(text);
    });
  }

  const blockedPassive: { label: string; text: string }[] = [
    { label: 'modal passive, "by our AI"', text: 'A custom IVR will be built by our AI.' },
    { label: 'modal passive, "by our assistant"', text: 'A multi-level phone menu can be configured by our assistant.' },
    { label: 'modal passive compound (designed and deployed), "by our system"', text: 'Your IVR will be designed and deployed by our system.' },
    { label: 'modal passive set-up, "call menu" object, "by our bot"', text: 'A custom call menu will be set up by our bot.' },
    { label: 'modal passive, bare/"the"-prefixed agent', text: 'A custom IVR will be built by the assistant.' },
    // The three tenses the prior round's Codex review found missing:
    { label: 'simple present passive ("is configured by")', text: 'Your IVR is configured by our assistant.' },
    { label: 'present progressive passive ("is being set up by")', text: 'Your call menu is being set up by our bot.' },
    { label: 'simple past passive ("was designed by")', text: 'The multi-level phone menu was designed by our system.' },
    { label: 'present perfect passive ("has been implemented by")', text: 'A custom IVR has been implemented by the assistant.' },
  ];
  for (const { label, text } of blockedPassive) {
    it(`blocks (passive): ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr_passive');
      expect(result.text).not.toBe(text);
    });
  }

  it('does not let an earlier build claim excuse a later, different sentence (sentence-aware, not text-wide)', () => {
    const result = guardReply(
      'I can build you a custom IVR. A specialist would need to design a custom multi-level phone menu for anything more advanced.',
      SALES_TENANT,
    );
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('complex_ivr');
  });

  it('does not let a positive claim elsewhere excuse — an unrelated "we" earlier never attaches to a later, unrelated object', () => {
    const result = guardReply(
      "We're happy to help! A specialist would need to design a custom multi-level phone menu.",
      SALES_TENANT,
    );
    expect(result.blocked).toBe(false);
  });

  it('populates forensics (length + sha256) on a blocked reply, never the raw text itself', () => {
    const text = 'I can build you a custom IVR.';
    const result = guardReply(text, SALES_TENANT);
    expect(result.blocked).toBe(true);
    expect(result.forensics?.originalLength).toBe(text.length);
    expect(result.forensics?.originalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.forensics?.originalSha256).not.toBe(text);
  });

  it('does not populate forensics on a passing reply', () => {
    const result = guardReply('We can discuss available PBX and IVR options with you.', SALES_TENANT);
    expect(result.blocked).toBe(false);
    expect(result.forensics).toBeUndefined();
  });
});

describe('guardReply — complex_ivr bounded adverb phrase + finite-clause conjunction detection (Codex review follow-up, PR #75)', () => {
  // Codex found the active matcher required the verb IMMEDIATELY after the aux/modal, so a
  // common adverb in between ("can automatically configure") slipped through unblocked. The
  // fix is a BOUNDED optional adverb phrase (zero, one, or two "-ly"/whitelisted adverbs joined
  // by "and") — never an arbitrary noun, object, determiner or clause.
  const blockedAdverb: { label: string; text: string }[] = [
    { label: '"-ly" adverb before verb', text: 'Our assistant can automatically configure an IVR.' },
    { label: '"-ly" adverb, different verb', text: 'Our AI will quickly build a custom IVR.' },
    { label: 'whitelisted non-"-ly" adverb ("also") + hyphenated set-up', text: 'Our bot can also set-up your call menu.' },
    { label: 'two adverbs joined by "and" ("securely and automatically")', text: 'Our system can securely and automatically design a multi-level menu.' },
    { label: '"-ly" adverb ("definitely")', text: 'We can definitely design a multi-level phone menu.' },
    { label: '"-ly" adverb ("personally") + contraction', text: 'I’ll personally create a multi-level menu for you.' },
    { label: 'whitelisted non-"-ly" adverb ("currently") + present progressive', text: 'Our assistant is currently setting up your IVR.' },
  ];
  for (const { label, text } of blockedAdverb) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
      expect(result.text).not.toBe(text);
    });
  }

  // Codex separately found the clause-splitter only recognized a comma-preceded conjunction, so
  // an unpunctuated "and"/"but" left the whole sentence as one clause and reintroduced the
  // cross-clause false positive. The fix treats a bare conjunction as a boundary only when the
  // text after it plausibly opens a new independent clause (a subject immediately followed by an
  // auxiliary/modal) — never merely because "and"/"but"/etc. appears.
  const blockedCommaless: { label: string; text: string }[] = [
    { label: 'comma-less "but": negated first clause, positive second clause', text: 'We cannot build that PBX today but our assistant will configure your IVR tomorrow.' },
    { label: 'comma-less "and": unrelated first clause, positive second clause', text: 'We can discuss the plan and our AI can create your IVR.' },
    { label: 'compound verb ("design and deploy") — same clause, must still block', text: 'Our AI can design and deploy your IVR.' },
    { label: 'compound verb ("build and configure") — same clause, must still block', text: 'Our assistant can build and configure a multi-level phone menu.' },
    // The "and" joining two adverbs must never itself be mistaken for a clause boundary — the
    // whole clause (including the adverb phrase) must still resolve as one genuine claim.
    { label: 'adverb-joining "and" ("securely and automatically") is not a clause boundary', text: 'Our system can securely and automatically configure the IVR.' },
  ];
  for (const { label, text } of blockedCommaless) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
      expect(result.text).not.toBe(text);
    });
  }

  // The critical negative space: a bare conjunction must NOT split a compound verb, a compound
  // object, an ordinary list, or a product-name conjunction — all of these must still pass.
  const allowedCommaless: { label: string; text: string }[] = [
    { label: 'comma-less "and": separate clause with its own IVR/call-menu subject', text: 'We can configure your WhatsApp greeting and a call menu can route callers to sales.' },
    { label: 'comma-less "and": separate clause, IVR subject', text: 'Our assistant can explain call routing and an IVR can direct callers to departments.' },
    { label: 'ordinary list, no new clause', text: 'An IVR can route callers to sales and support.' },
    { label: 'product-name conjunction, no new clause', text: 'EPIC offers IVR and call routing.' },
    { label: 'compound object, no new clause', text: 'We can configure your greeting and voicemail.' },
    { label: 'ordinary list, no new clause (2)', text: 'We can discuss IVR and PBX options.' },
    { label: 'human attribution + adverb — subject is human, not our AI', text: 'A qualified specialist can automatically configure your IVR.' },
    { label: 'human attribution ("our engineering team") + adverb, different object', text: 'Our engineering team can quickly design the custom call flow.' },
    { label: 'comma-less "and": separate clause, human subject (specialist)', text: 'We can discuss your phone setup and a specialist would configure any custom IVR.' },
    { label: 'adverb before an untracked verb ("explain") — never a capability claim', text: 'Our assistant can automatically explain how an IVR works.' },
  ];
  for (const { label, text } of allowedCommaless) {
    it(`does not block: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(text);
    });
  }

  // Negation must remain both sentence- and clause-aware with the new adverb phrase and
  // comma-less conjunction logic in place.
  const negationAllowed: { label: string; text: string }[] = [
    { label: 'negated + adverb ("cannot automatically")', text: 'Our assistant cannot automatically configure an IVR.' },
    { label: 'negated with "do not" + adverb', text: 'We do not directly build custom call menus.' },
    { label: 'negated + adverb ("cannot currently")', text: 'Our AI cannot currently set up your IVR.' },
  ];
  for (const { label, text } of negationAllowed) {
    it(`does not block: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(text);
    });
  }

  const negationBlocked: { label: string; text: string }[] = [
    {
      label: 'comma-less "but": negated first clause + adverb in the positive second clause',
      text: 'We cannot configure the PBX today but our assistant will automatically build your IVR tomorrow.',
    },
    {
      label: 'comma "but" + pronoun "it" referring back to "Our AI" in the negated first clause',
      text: 'Our AI does not build ordinary greetings, but it can directly configure your custom IVR.',
    },
  ];
  for (const { label, text } of negationBlocked) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
    });
  }
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

  it('passes the ratified SBL founding-promo prices unchanged (EC$187.50 setup installment + EC$124.50/mo)', () => {
    const text = 'The founding promo SBL setup is EC$187.50 before work + EC$187.50 at acceptance, then EC$124.50/mo for months 1-3.';
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

// ─── Correction round 2 (PR #75): three confirmed matcher defects ────────────
// defect-foundation-claim-guard-complex-ivr-overbroad-post-generation-filter-2026-08-05

describe('guardReply — defect 1: first-person progressive capability claims', () => {
  const BLOCKED: { label: string; text: string }[] = [
    { label: "contracted 'm (ASCII apostrophe)", text: "I'm setting up an IVR for you." },
    { label: 'contracted smart-apostrophe m', text: 'I’m setting up an IVR for you.' },
    { label: 'worded "am"', text: 'I am setting up an IVR.' },
    { label: "contracted 're (ASCII apostrophe)", text: "We're setting up your IVR." },
    { label: 'contracted smart-apostrophe re', text: 'We’re setting up your IVR.' },
    { label: 'worded "are"', text: 'We are setting up your call menu.' },
    { label: 'contracted m + adverb + multi-level phone menu', text: "I'm currently configuring a multi-level phone menu." },
    { label: 'contracted re + adverb', text: "We're automatically building your IVR." },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
    });
  }

  // Negation must survive the new auxiliary forms — the compound-predicate scan must never
  // step over "not"/"unable" to reach the capability verb behind it.
  const PASSES: { label: string; text: string }[] = [
    { label: 'contracted m + not', text: "I'm not setting up an IVR." },
    { label: 'am + not', text: 'I am not configuring a call menu.' },
    { label: 'contracted re + unable to', text: "We're unable to build a custom IVR." },
    { label: 'are + not + adverb', text: 'We are not currently setting up your phone menu.' },
  ];
  for (const { label, text } of PASSES) {
    it(`passes: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }

  // A negated first clause never excuses a positive later clause.
  const LATER_POSITIVE: { label: string; text: string }[] = [
    { label: 'comma+but, worded "am" second clause', text: "I'm not configuring the PBX today, but I am setting up your IVR." },
    { label: 'comma+but, contracted re second clause', text: "We're unable to build the greeting, but we're configuring the call menu." },
    { label: 'semicolon, smart-apostrophe second clause', text: 'I am not changing voicemail; I’m setting up your IVR instead.' },
  ];
  for (const { label, text } of LATER_POSITIVE) {
    it(`blocks (later positive clause): ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }
});

describe('guardReply — defect 2: punctuation must not sever a shared subject', () => {
  const BLOCKED: { label: string; text: string }[] = [
    { label: 'comma+and continuing a compound predicate', text: 'We can configure your greeting, and set up an IVR.' },
    { label: 'comma+and, different leading verb', text: 'Our assistant can update voicemail, and configure your call menu.' },
    { label: 'colon introducing the direct object', text: 'We can build this for you: a custom IVR.' },
    { label: 'colon introducing a complement', text: 'Our AI can provide the following: a multi-level phone menu.' },
    { label: 'bare "and" compound predicate (no comma)', text: 'We can configure your greeting and set up an IVR.' },
    { label: 'compound capability verbs sharing one object', text: 'Our assistant can build and deploy your call menu.' },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }

  // A comma+conjunction that genuinely opens an independent finite clause must still split, so
  // the new clause is judged on its own subject.
  it('still splits when the conjunction opens a finite clause with a non-agent subject (passes)', () => {
    expect(guardReply('We can configure your greeting, and a call menu can route callers.', SALES_TENANT).blocked).toBe(false);
  });
  it('still splits when the conjunction opens a finite clause with an agent subject (blocks)', () => {
    expect(guardReply('We cannot build that today, but our assistant will configure your IVR.', SALES_TENANT).blocked).toBe(true);
  });
  it('still splits on "and the system can ..." (blocks on the second clause)', () => {
    expect(guardReply('We can explain the plans, and the system can create your call menu.', SALES_TENANT).blocked).toBe(true);
  });

  // A colon whose left side is not a capability claim, or whose verb is explanatory rather than
  // constructive, must not block just because an IVR noun follows the colon.
  const COLON_PASSES: { label: string; text: string }[] = [
    { label: 'explanatory verb + colon', text: 'We can explain the following: how an IVR routes callers.' },
    { label: 'bare present provisioning (no auxiliary) + colon', text: 'We provide documentation: an IVR overview and setup guide.' },
    { label: 'discussion verb + colon', text: 'We can discuss this topic: IVR options for small businesses.' },
  ];
  for (const { label, text } of COLON_PASSES) {
    it(`passes: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }

  it('a comma list of objects is not a clause boundary and carries no IVR object (passes)', () => {
    expect(guardReply('We can configure voicemail, greetings and call routing.', SALES_TENANT).blocked).toBe(false);
  });
  it('a three-verb compound predicate stays one clause and blocks', () => {
    expect(guardReply('Our assistant can design, build and deploy your call menu.', SALES_TENANT).blocked).toBe(true);
  });
});

describe('guardReply — defect 3: bounded direct-object window', () => {
  it('exposes the token limit as a named, inspectable constant', () => {
    expect(IVR_OBJECT_TOKEN_LIMIT).toBe(7);
  });

  // The false positive this defect was raised for: an honest relationship answer whose only IVR
  // mention sits inside an attached relative clause with no punctuation boundary at all.
  const PASSES: { label: string; text: string }[] = [
    { label: 'relative clause introduced by "who"', text: 'We can build a strong relationship with every customer who eventually asks about IVR options down the road.' },
    { label: 'subordinate clause introduced by "while"', text: 'We can build trust while explaining IVR options.' },
    { label: '"that" as a subordinate-clause marker, not a determiner', text: 'We can create a support plan that includes a discussion of IVR options.' },
    { label: 'relative clause introduced by "which"', text: 'We can design a strategy for businesses which may later consider an IVR.' },
    { label: 'object beyond the token limit after a colon', text: 'We can build this for you: an explanation of how IVR works.' },
    { label: 'separate finite clause owns the IVR subject', text: 'We can configure your greeting, and an IVR can route callers to sales.' },
    { label: 'explanatory verb, not a capability verb', text: 'Our assistant can explain how a call menu works.' },
    { label: 'help-understand framing', text: 'We can help your team understand multi-level phone menus.' },
    { label: 'human attribution (specialist subject)', text: 'A human specialist can build a custom IVR.' },
    { label: 'human attribution (engineering team subject)', text: 'Our engineering team can configure the call menu.' },
  ];
  for (const { label, text } of PASSES) {
    it(`passes: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }

  const BLOCKED: { label: string; text: string }[] = [
    { label: 'minimal direct object', text: 'We can build an IVR.' },
    { label: 'determiner + adjective + object', text: 'We can build a custom IVR for your business.' },
    { label: 'adverb before verb, multi-word object', text: 'We can quickly build your multi-level phone menu.' },
    { label: 'compound verb resets the object window', text: 'We can build and deploy your IVR.' },
    { label: 'fronted prepositional phrase before the object', text: 'We can build for your business a custom IVR.' },
    { label: 'provisioning verb with an auxiliary', text: 'We can provide you with a custom call menu.' },
    { label: 'object followed by a reduced relative clause', text: 'Our assistant can create the call menu you described.' },
    { label: 'adjective-stacked object', text: 'Our AI can configure a secure multi-level phone menu.' },
    { label: 'first-person progressive (defect 1 interaction)', text: "I'm setting up an IVR for you." },
    { label: 'colon complement (defect 2 interaction)', text: 'We can build this for you: a custom IVR.' },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }
});

// ─── Correction round 2, Codex follow-up at 219ba56 ──────────────────────────
// Two P1 findings from the exact-SHA review of the round above.

describe('guardReply — full auxiliary/modal coverage on the active matcher', () => {
  // The auxiliary alternation previously stopped at 'll/will/can/could/would/also/is/are, so
  // these standard modal and perfect forms were unreachable by the active matcher entirely.
  const BLOCKED: { label: string; text: string }[] = [
    { label: 'modal "may"', text: 'We may configure your IVR.' },
    { label: 'modal "might"', text: 'We might build your call menu.' },
    { label: 'modal "should"', text: 'Our assistant should create your IVR.' },
    { label: 'modal "must"', text: 'We must build a custom IVR.' },
    { label: 'present perfect "has"', text: 'Our AI has configured your IVR.' },
    { label: 'past progressive "was"', text: 'Our AI was setting up your call menu.' },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      const result = guardReply(text, SALES_TENANT);
      expect(result.blocked).toBe(true);
      expect(result.rule).toBe('complex_ivr');
    });
  }

  const PASSES: { label: string; text: string }[] = [
    { label: 'modal "may" + not', text: 'We may not configure your IVR.' },
    { label: 'modal "might" + not', text: 'We might not build your call menu.' },
  ];
  for (const { label, text } of PASSES) {
    it(`passes: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }
});


// ─── Correction round 2, Codex follow-up at 7f871af ──────────────────────────
// Two further findings from the exact-SHA review: a compound-predicate bypass via
// filler "that", and false positives from the lexical subordinator list it replaced.

describe('guardReply — "that" position decides determiner vs relative pronoun', () => {
  // Determiner: immediately after the capability verb, so it introduces that verb's own object.
  const BLOCKED: { label: string; text: string }[] = [
    { label: 'bare determiner object', text: 'We can build that IVR.' },
    { label: 'determiner object behind a modifier', text: 'We can build that custom IVR.' },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }

  // Relative pronoun: an intervening noun phrase is its antecedent, so the subordinate clause's
  // own verb owns the IVR mention. Position alone decides this — no lexical verb list, which is
  // what previously mis-blocked "that helps explain" / "that lists" / "that evaluates".
  const PASSES: { label: string; text: string }[] = [
    { label: 'relative "that helps explain"', text: 'We can create a plan that helps explain IVR options.' },
    { label: 'relative "that lists"', text: 'We can create a plan that lists IVR options.' },
    { label: 'relative "that evaluates"', text: 'We can create a plan that evaluates IVR options.' },
    { label: 'relative "that includes"', text: 'We can create a support plan that includes a discussion of IVR options.' },
    { label: 'relative "that covers"', text: 'We can create a plan that covers IVR options.' },
    { label: 'relative clause with its own auxiliary', text: 'We can design a roadmap that will include an IVR later.' },
  ];
  for (const { label, text } of PASSES) {
    it(`passes: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(false);
    });
  }
});

describe('guardReply — filler "that" must not hide a later capability verb', () => {
  // The verb scan used to stop dead on any "that", so a compound predicate whose first verb was
  // non-capability ("do that", "help with that") slipped the matcher entirely.
  const BLOCKED: { label: string; text: string }[] = [
    { label: 'do that and configure', text: 'We can do that and configure your IVR.' },
    { label: 'do that and create (agent subject)', text: 'Our assistant can do that and create your call menu.' },
    { label: 'help with that and set up', text: 'We can help with that and set up an IVR.' },
    { label: 'comma+and continuation after filler "that"', text: 'We can do that, and configure your IVR.' },
  ];
  for (const { label, text } of BLOCKED) {
    it(`blocks: ${label}`, () => {
      expect(guardReply(text, SALES_TENANT).blocked).toBe(true);
    });
  }
});
