import { describe, it, expect } from 'vitest';
import { detectEscalationClaim } from './escalation-claim';

describe('detectEscalationClaim — the exact repro (defect-lite-concierge-stale-owner-active-silent-drop-2026-07-21)', () => {
  it('flags conversation #100\'s actual reply text', () => {
    const text =
      "Absolutely — I've already escalated your request to a human team member. They'll take it from here. " +
      "Thanks for reaching out, and someone from EPIC will be with you shortly!";
    const r = detectEscalationClaim(text);
    expect(r.claims).toBe(true);
    expect(r.rule).toBe('already_escalated');
  });
});

describe('detectEscalationClaim — claims a human has been engaged (must force handoff)', () => {
  const cases: { label: string; text: string; rule: string }[] = [
    {
      label: 'already escalated',
      text: "I've already escalated this to a human team member — they'll take it from here.",
      rule: 'already_escalated',
    },
    {
      label: 'escalated this to our support team',
      text: "I've escalated this to our support team, they'll follow up shortly.",
      rule: 'escalated_to_human',
    },
    {
      label: 'connected you with a member of the team',
      text: "I've connected you with a member of our team who will reach out shortly.",
      rule: 'connected_to_human',
    },
    {
      label: 'someone will be with you shortly',
      text: 'No problem — someone will be with you shortly.',
      rule: 'human_will_assist',
    },
    {
      label: 'a team member will reach out',
      text: 'A team member will reach out to you within the hour.',
      rule: 'human_will_assist',
    },
    {
      label: 'flagged this for our team',
      text: "I've flagged this for our team to review.",
      rule: 'flagged_for_team',
    },
  ];
  for (const { label, text, rule } of cases) {
    it(`claims: ${label}`, () => {
      const r = detectEscalationClaim(text);
      expect(r.claims).toBe(true);
      expect(r.rule).toBe(rule);
    });
  }
});

describe('detectEscalationClaim — routine/legitimate replies (must NOT force handoff)', () => {
  const cases: { label: string; text: string }[] = [
    {
      label: 'general team-availability statement',
      text: 'Our team is available Monday to Friday, 9am–5pm.',
    },
    {
      label: 'habitual response-time statement (no specific claim for this conversation)',
      text: 'Thanks for your patience — a team member typically responds within a few hours on weekdays.',
    },
    {
      label: 'honest negative disclaimer about live agents',
      text: "We don't have live agents right now, but I can help with most questions here.",
    },
    {
      label: 'connect to a non-human resource, not a person',
      text: 'I can connect you with our booking calendar if you want to pick a time yourself.',
    },
    {
      label: 'routine ops language mentioning "team" with no escalation verb',
      text: 'Let me get a team together to look at bulk pricing options for you.',
    },
  ];
  for (const { label, text } of cases) {
    it(`does not claim: ${label}`, () => {
      expect(detectEscalationClaim(text).claims).toBe(false);
    });
  }
});

describe('detectEscalationClaim — conditional/instructional offers excluded (near-miss guard)', () => {
  it('does not fire on a standing "reply agent for a human" menu option', () => {
    // Textually contains "someone ... will ... assist you" (would otherwise match
    // human_will_assist), but "If you'd like" + "just reply" mark it as a standing
    // option the customer may invoke, not a claim that escalation already happened.
    const text = "If you'd like to speak with a human, just reply 'agent' and someone will assist you.";
    expect(detectEscalationClaim(text).claims).toBe(false);
  });

  it('does not fire on a conditional future offer to connect', () => {
    const text = 'If you need anything else, just ask and I can connect you with a person.';
    expect(detectEscalationClaim(text).claims).toBe(false);
  });
});
