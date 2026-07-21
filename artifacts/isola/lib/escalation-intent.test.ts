import { describe, it, expect } from 'vitest';
import { detectEscalationIntent } from './escalation-intent';

const SALES = 'ema_sales_tenant';
const OTHER = 'some-other-tenant';

describe('detectEscalationIntent — forces handoff on high-stakes sales intents', () => {
  const escalate: { label: string; text: string; category: string }[] = [
    { label: 'cancel subscription', text: 'I want to cancel my subscription.', category: 'cancellation' },
    { label: 'how do I cancel', text: 'How do I cancel?', category: 'cancellation' },
    { label: 'terminate service', text: 'Please terminate my service at the end of the month.', category: 'cancellation' },
    { label: 'custom price', text: 'Can we negotiate a custom price for 3 lines?', category: 'price_negotiation' },
    { label: 'discount', text: 'Is there a discount for paying annually?', category: 'price_negotiation' },
    { label: 'cheaper', text: 'Do you have anything cheaper?', category: 'price_negotiation' },
    { label: 'refund overcharged', text: 'I need a refund, I was overcharged last month.', category: 'refund_billing_dispute' },
    { label: 'billing error', text: 'There is a billing error on my invoice.', category: 'refund_billing_dispute' },
    { label: 'speak to a human', text: 'Can I speak to a human please?', category: 'human_request' },
    { label: 'talk to a manager', text: 'I want to talk to a manager.', category: 'human_request' },
    { label: 'complaint', text: 'I have a complaint about the service.', category: 'complaint' },
    { label: 'unhappy', text: "I'm really unhappy with how this is going.", category: 'complaint' },
    { label: 'contract', text: 'Do I have to sign a contract?', category: 'contract_legal' },
    { label: 'lawyer', text: 'My lawyer will be in touch about this.', category: 'contract_legal' },
  ];
  for (const { label, text, category } of escalate) {
    it(`escalates (${category}): ${label}`, () => {
      const r = detectEscalationIntent(text, SALES);
      expect(r.escalate).toBe(true);
      expect(r.category).toBe(category);
    });
  }

  const noEscalate: { label: string; text: string }[] = [
    { label: 'routine price question', text: 'How much is the Smart Business Line?' },
    { label: 'wa capability', text: 'Can your AI answer my WhatsApp messages?' },
    { label: 'whats included', text: "What's included in the founding pilot?" },
    { label: 'softphone setup', text: 'How do I set up the softphone app?' },
    { label: 'make calls', text: 'Can I make and receive calls on my number?' },
    { label: 'greeting', text: 'Hi, I run a dental clinic and want to learn more.' },
  ];
  for (const { label, text } of noEscalate) {
    it(`does not escalate a routine message: ${label}`, () => {
      expect(detectEscalationIntent(text, SALES).escalate).toBe(false);
    });
  }

  it('never escalates for a non-sales tenant, even with escalation keywords', () => {
    expect(detectEscalationIntent('I want to cancel and get a refund from a human manager', OTHER).escalate).toBe(false);
  });
});
