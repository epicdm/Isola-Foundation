import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bot, MessageSquare, Wallet, Zap } from 'lucide-react';

import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { OutcomeMetricCard, TrendMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { AttentionQueue, type AttentionItem } from '@/components/composite/attention-queue';
import { EmptyState } from '@/components/composite/empty-state';
import { ProvisioningProgress } from '@/components/composite/provisioning-progress';
import { RiskNotice } from '@/components/composite/risk-notice';
import { AssistantTeamCard, type AssistantTeamMember } from '@/components/composite/assistant-team-card';
import { ContextWorkspaceHeader } from '@/components/composite/context-workspace-header';

// Composite layer contract tests. These pin the behaviours the golden-screen
// review actually accepted — whole-card navigation, honest empty copy, no
// runtime/model vocabulary on customer-facing surfaces — so a later edit that
// silently regresses one of them fails here rather than in production.

describe('OwnerPageHeader', () => {
  it('renders the title and optional eyebrow', () => {
    const html = renderToStaticMarkup(<OwnerPageHeader eyebrow="Acme Ltd" title="What needs your attention" />);
    expect(html).toContain('Acme Ltd');
    expect(html).toContain('What needs your attention');
    expect(html).toContain('<h1');
  });

  it('omits the eyebrow element entirely when not supplied', () => {
    const html = renderToStaticMarkup(<OwnerPageHeader title="Workspace" />);
    expect(html).toContain('Workspace');
    expect(html).not.toContain('text-sm text-muted-foreground');
  });

  it('renders actions when supplied', () => {
    const html = renderToStaticMarkup(<OwnerPageHeader title="AI Team" actions={<span>TAKEOVER</span>} />);
    expect(html).toContain('TAKEOVER');
  });
});

describe('OutcomeMetricCard — navigation', () => {
  const linked: OutcomeMetric = { label: 'Open Conversations', value: '7', icon: MessageSquare, href: '/inbox', trend: 'View inbox', trendTone: 'positive' };
  const plain: OutcomeMetric = { label: 'AI Usage (tokens)', value: '1,200', icon: Bot, trend: 'tokens consumed this month' };

  it('wraps the ENTIRE card in a link when href is set', () => {
    const html = renderToStaticMarkup(<OutcomeMetricCard metric={linked} />);
    const anchor = html.indexOf('<a');
    expect(anchor).toBeGreaterThanOrEqual(0);
    // the metric value must live inside the anchor, not merely next to it
    expect(html.indexOf('7')).toBeGreaterThan(anchor);
    expect(html).toContain('href="/inbox"');
  });

  it('gives the link an accessible name carrying label, value and trend', () => {
    const html = renderToStaticMarkup(<OutcomeMetricCard metric={linked} />);
    expect(html).toContain('aria-label="Open Conversations: 7. View inbox"');
  });

  it('renders no anchor at all when href is absent', () => {
    const html = renderToStaticMarkup(<OutcomeMetricCard metric={plain} />);
    expect(html).not.toContain('<a ');
    expect(html).toContain('AI Usage (tokens)');
  });

  it('labels AI consumption as tokens, never as turns', () => {
    const html = renderToStaticMarkup(<OutcomeMetricCard metric={plain} />);
    expect(html).toContain('tokens');
    expect(html).not.toMatch(/AI Turns/i);
  });

  it('TrendMetricCard renders a static (non-navigating) metric', () => {
    const html = renderToStaticMarkup(<TrendMetricCard label="Handovers" value="3" trend="last 7 days" />);
    expect(html).toContain('Handovers');
    expect(html).not.toContain('<a ');
  });
});

describe('AttentionQueue', () => {
  const item: AttentionItem = { id: 'onboard', icon: Zap, title: 'Connect WhatsApp to get started', sub: 'Your AI agent is ready.', cta: 'Connect', href: '/onboard', tone: 'primary' };

  it('renders a truthful all-clear state when there is nothing to act on', () => {
    const html = renderToStaticMarkup(<AttentionQueue items={[]} />);
    expect(html).toContain('Nothing needs your attention right now');
  });

  it('renders each item with its concrete CTA target', () => {
    const html = renderToStaticMarkup(<AttentionQueue items={[item]} />);
    expect(html).toContain('Connect WhatsApp to get started');
    expect(html).toContain('href="/onboard"');
    expect(html).toContain('Connect');
  });

  it('applies a per-tone left border as a literal class Tailwind can see', () => {
    const html = renderToStaticMarkup(<AttentionQueue items={[{ ...item, tone: 'warning' }]} />);
    expect(html).toContain('border-l-warning');
    expect(html).not.toContain('border-l-[var(');
  });

  it('omits the age element entirely rather than rendering a blank one', () => {
    const withAge = renderToStaticMarkup(<AttentionQueue items={[{ ...item, age: '2d' }]} />);
    const withoutAge = renderToStaticMarkup(<AttentionQueue items={[item]} />);
    expect(withAge).toContain('2d');
    expect(withoutAge).not.toContain('sm:inline');
  });

  it('stacks vertically below the sm breakpoint', () => {
    const html = renderToStaticMarkup(<AttentionQueue items={[item]} />);
    expect(html).toContain('flex-col');
    expect(html).toContain('sm:flex-row');
  });
});

describe('EmptyState', () => {
  it('renders title and body for the default card variant', () => {
    const html = renderToStaticMarkup(<EmptyState icon={MessageSquare} title="No conversations yet" body="Conversations will appear here once customers reach out." />);
    expect(html).toContain('No conversations yet');
    expect(html).toContain('once customers reach out');
    expect(html).toContain('border-dashed');
  });

  it('uses compact chrome for the inline variant', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Nothing here" body="Nothing yet." variant="inline" />);
    expect(html).toContain('rounded-md');
    expect(html).not.toContain('border-dashed');
  });

  it('uses page chrome and a larger icon for the page variant', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="Nothing here" body="Nothing yet." variant="page" />);
    expect(html).toContain('p-16');
    expect(html).toContain('size-10');
  });

  it('renders an optional action', () => {
    const html = renderToStaticMarkup(<EmptyState icon={Wallet} title="T" body="B" action={<span>DO IT</span>} />);
    expect(html).toContain('DO IT');
  });
});

describe('ProvisioningProgress', () => {
  const html = renderToStaticMarkup(
    <ProvisioningProgress
      steps={[
        { id: 'a', title: 'Account created', note: 'Done automatically', state: 'done' },
        { id: 'b', title: 'Number being connected', note: 'EPIC is handling this', state: 'active' },
        { id: 'c', title: 'Go live', note: 'Waiting on the previous step', state: 'todo' },
      ]}
    />,
  );

  it('exposes the steps as a semantic list', () => {
    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
  });

  it('marks the in-progress step with aria-current="step"', () => {
    expect(html).toContain('aria-current="step"');
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1);
  });

  it('announces status textually, not by colour alone', () => {
    expect(html).toContain('Status: ');
    expect(html).toContain('In progress');
  });

  it('never names the backend system doing the work', () => {
    expect(html).not.toMatch(/magnus|clawith|chatwoot|odoo/i);
  });
});

describe('RiskNotice', () => {
  const html = renderToStaticMarkup(<RiskNotice title="Wallet is low" body="Top up to keep calls connecting." actionLabel="Top up" onAction={() => {}} />);

  it('is announced as an alert', () => {
    expect(html).toContain('role="alert"');
  });

  it('names the blocker and a single next action', () => {
    expect(html).toContain('Wallet is low');
    expect(html).toContain('Top up');
  });

  it('uses semantic warning tokens, not arbitrary palette colours', () => {
    expect(html).toContain('border-warning/30');
    expect(html).toContain('bg-warning/10');
    expect(html).not.toMatch(/bg-(amber|yellow|orange)-\d{3}/);
  });
});

describe('AssistantTeamCard', () => {
  const member: AssistantTeamMember = {
    id: 'a1', name: 'Front Desk', job: 'Answers new enquiries', status: 'Active',
    channels: ['WhatsApp', 'Voice'], currentWork: 'Replying to 3 customers',
    outcome: '12 enquiries handled this week', handoff: 'Escalates to you after 2 replies',
    paused: false, onConfigure: () => {}, onTogglePause: () => {},
  };
  const html = renderToStaticMarkup(<AssistantTeamCard m={member} />);

  it('presents the assistant as a team member with a job', () => {
    expect(html).toContain('Front Desk');
    expect(html).toContain('Answers new enquiries');
    expect(html).toContain('12 enquiries handled this week');
  });

  it('never exposes runtime, model or engine vocabulary', () => {
    expect(html).not.toMatch(/runtime|model|gpt|claude|llm|clawith|token limit/i);
  });

  it('exposes pause state to assistive tech', () => {
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Pause');
    const pausedHtml = renderToStaticMarkup(<AssistantTeamCard m={{ ...member, paused: true, status: 'Paused' }} />);
    expect(pausedHtml).toContain('aria-pressed="true"');
    expect(pausedHtml).toContain('Resume');
  });
});

describe('ContextWorkspaceHeader', () => {
  const html = renderToStaticMarkup(
    <ContextWorkspaceHeader name="Acme Ltd" initials="AL" meta="Customer since 2024" primaryLabel="Log a call" onOpenConversation={() => {}} onPrimary={() => {}} />,
  );

  it('renders identity and context for the subject', () => {
    expect(html).toContain('Acme Ltd');
    expect(html).toContain('AL');
    expect(html).toContain('Customer since 2024');
  });

  it('uses customer-facing wording for the conversation link, not an internal tool name', () => {
    expect(html).toContain('View full conversation');
    expect(html).not.toMatch(/chatwoot/i);
  });
});
