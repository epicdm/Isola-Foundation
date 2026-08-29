/**
 * S3 recommended-action card and reply-review surface, rendered.
 *
 * Same arrangement as components/customer/workspace-view.test.tsx: no jsdom,
 * no @testing-library. These prove the MARKUP an operator is sent — that a
 * real Odoo link renders as a real <a>, that an absent link never fabricates
 * one, that the reply never claims the document was sent/attached/accepted,
 * and that no recommendation renders when Odoo produced none. Interaction
 * (click Prepare, edit, copy, cancel) is proven live by agent Chrome UAT —
 * renderToStaticMarkup cannot simulate a click.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Customer360Snapshot } from '@/lib/customer-360/contracts';

import { RecommendedActionCard, ReplyReview } from './customer-360-app';

// The S8-W1 badge wording is pinned in lib/customer-360/send-badge.test.ts.
// It deliberately does NOT live here: this file imports a component that
// imports a CSS module, and on some platforms that chain fails to LOAD — which
// makes every assertion in the file silently not run. Copy a human reads must
// be pinned somewhere that actually executes.

const baseSnapshot = (over: Partial<Customer360Snapshot> = {}): Customer360Snapshot => ({
  verifiedAt: '2026-08-27T12:00:00.000Z',
  freshness: 'fresh',
  conversation: { displayId: 15, currentRequest: null },
  customer: { id: 163, name: 'Patricia Yvonne Armour', email: 'p@example.test', phone: '+17672951770', city: null },
  balances: [],
  documents: [],
  openLoops: [],
  openLoopsAvailable: true,
  recommendedAction: null,
  ...over,
});

const draftQuotation = {
  id: 670,
  reference: 'S00670',
  kind: 'quotation' as const,
  state: 'draft',
  total: 4272.6,
  currency: 'XCD',
  date: '2026-08-20',
  odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/670',
};

describe('RecommendedActionCard', () => {
  it('renders nothing when Odoo produced no recommendation', () => {
    const markup = renderToStaticMarkup(
      <RecommendedActionCard snapshot={baseSnapshot()} onPrepareReply={() => {}} />,
    );
    expect(markup).toBe('');
  });

  it('renders the headline, document, amount and a REAL Odoo link', () => {
    const snapshot = baseSnapshot({
      recommendedAction: {
        kind: 'review-draft-quotation',
        headline: 'Review quotation S00670 and ask the customer whether they would like to proceed or request changes.',
        document: draftQuotation,
        reasoning: 'S00670 is a draft quotation — it has not been sent, approved or accepted.',
        suggestedReply: "Hi Patricia, I've reviewed quotation S00670 for XCD 4,272.60. Would you like to proceed, or is there anything you'd like adjusted?",
      },
    });
    const markup = renderToStaticMarkup(
      <RecommendedActionCard snapshot={snapshot} onPrepareReply={() => {}} />,
    );
    expect(markup).toContain('S00670');
    expect(markup).toContain('Review quotation S00670');
    expect(markup).toContain('href="https://epic-communications-inc.odoo.com/odoo/sale.order/670"');
    expect(markup).toContain('Prepare reply');
  });

  it('never fabricates a deep link when the server could not build one', () => {
    const snapshot = baseSnapshot({
      recommendedAction: {
        kind: 'review-draft-quotation',
        headline: 'Review quotation S00670 and ask the customer whether they would like to proceed or request changes.',
        document: { ...draftQuotation, odooLink: null },
        reasoning: 'S00670 is a draft quotation.',
        suggestedReply: 'Hi Patricia, ...',
      },
    });
    const markup = renderToStaticMarkup(
      <RecommendedActionCard snapshot={snapshot} onPrepareReply={() => {}} />,
    );
    expect(markup).not.toMatch(/<a[^>]*href="https?:\/\//);
    expect(markup).toContain('disabled');
  });
});

describe('ReplyReview', () => {
  it('shows the exact-effect disclaimer and never claims the document was sent, attached or accepted', () => {
    const snapshot = baseSnapshot({
      recommendedAction: {
        kind: 'review-draft-quotation',
        headline: 'Review quotation S00670...',
        document: draftQuotation,
        reasoning: '...',
        suggestedReply: "Hi Patricia, I've reviewed quotation S00670 for XCD 4,272.60. Would you like to proceed, or is there anything you'd like adjusted?",
      },
    });
    const markup = renderToStaticMarkup(<ReplyReview snapshot={snapshot} onClose={() => {}} />);
    expect(markup).toContain('will not send a message or change Odoo');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Copy suggested reply');
    expect(markup).toContain('does not currently support inserting text');
    // the disclaimer's own "send" is fine; the reply body itself must not claim
    // the document is sent/attached/accepted
    expect(markup.toLowerCase()).not.toMatch(/document (was|is) sent/);
    expect(markup.toLowerCase()).not.toContain('attached');
    expect(markup.toLowerCase()).not.toContain('accepted');
  });

  it('renders nothing when there is no recommendation to review', () => {
    const markup = renderToStaticMarkup(<ReplyReview snapshot={baseSnapshot()} onClose={() => {}} />);
    expect(markup).toBe('');
  });
});
