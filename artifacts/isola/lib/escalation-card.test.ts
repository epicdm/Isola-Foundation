import { describe, it, expect } from 'vitest';
import {
  buildEscalationCard,
  describeReason,
  truncateForNote,
  QUOTE_LIMIT,
} from './escalation-card';

describe('truncateForNote', () => {
  it('collapses whitespace', () => {
    expect(truncateForNote('a\n\n  b   c')).toBe('a b c');
  });

  it('leaves short text intact', () => {
    expect(truncateForNote('hello')).toBe('hello');
  });

  it('trims overlong text and marks the cut', () => {
    const long = 'x'.repeat(QUOTE_LIMIT + 50);
    const out = truncateForNote(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(QUOTE_LIMIT + 1);
  });

  it('honours a custom limit', () => {
    expect(truncateForNote('abcdef', 3)).toBe('abc…');
  });
});

describe('describeReason', () => {
  it('maps a known reason to plain language', () => {
    expect(describeReason('low-confidence')).toBe('The assistant was not confident in its answer.');
  });

  it('strips the escalated: namespace our code already writes', () => {
    expect(describeReason('escalated:human-request')).toBe('The customer asked to speak to a person.');
  });

  it('passes an unknown reason through rather than dropping it', () => {
    expect(describeReason('billing dispute over invoice')).toBe('billing dispute over invoice');
  });

  it('falls back to a generic line when there is no reason', () => {
    expect(describeReason(null)).toMatch(/flagged this conversation/i);
  });
});

describe('buildEscalationCard', () => {
  const full = {
    customerMessage: 'Can you port my existing number to your service?',
    aiReply: 'I am not certain about that — let me get a colleague to confirm.',
    reason: 'low-confidence',
    contactName: 'Eric',
    contactPhone: '+17672958382',
  };

  it('includes the reason, both messages and the contact', () => {
    const card = buildEscalationCard(full);
    expect(card).toContain('Human help needed');
    expect(card).toContain('The assistant was not confident in its answer.');
    expect(card).toContain('> Can you port my existing number to your service?');
    expect(card).toContain('> I am not certain about that');
    expect(card).toContain('**Contact:** Eric · +17672958382');
  });

  // The old note said only "flagged for human review" — the whole point of
  // this module is that an agent can see the ask without scrolling back.
  it('surfaces what the customer wanted, not just that something happened', () => {
    expect(buildEscalationCard(full)).toContain('port my existing number');
  });

  it('never returns empty, even with no context at all', () => {
    const card = buildEscalationCard({});
    expect(card.trim().length).toBeGreaterThan(0);
    expect(card).toContain('Human help needed');
  });

  it('omits sections that have no content rather than printing empty headings', () => {
    const card = buildEscalationCard({ customerMessage: 'help' });
    expect(card).toContain('**Customer asked:**');
    expect(card).not.toContain('**Assistant replied:**');
    expect(card).not.toContain('**Contact:**');
  });

  it('treats whitespace-only fields as absent', () => {
    const card = buildEscalationCard({ customerMessage: '   ', aiReply: '\n\n' });
    expect(card).not.toContain('**Customer asked:**');
    expect(card).not.toContain('**Assistant replied:**');
  });

  it('renders a contact with only a phone number', () => {
    expect(buildEscalationCard({ contactPhone: '+1767' })).toContain('**Contact:** +1767');
  });

  it('truncates a very long customer message', () => {
    const card = buildEscalationCard({ customerMessage: 'y'.repeat(QUOTE_LIMIT + 100) });
    expect(card).toContain('…');
  });

  // A private note is one boolean away from being delivered to the customer,
  // so the card must not carry internal identifiers or model detail.
  it('contains no internal identifiers or model detail', () => {
    const card = buildEscalationCard(full);
    expect(card).not.toMatch(/tenant|token|model|prompt|api_access|conversation_id/i);
  });
});
