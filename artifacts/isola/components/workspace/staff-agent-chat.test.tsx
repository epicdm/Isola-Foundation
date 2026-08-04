import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaffAgentChat } from './staff-agent-chat';

// Proves the S1 TRUTHFUL UI requirements render on the initial (empty-thread)
// state: the LIVE_ASSISTED label, the zero-tool banner, the "not saved"
// notice, and the empty-conversation prompt. No network call happens during
// a static render, so this exercises exactly what a user sees before sending
// anything.
describe('StaffAgentChat — initial render', () => {
  const html = renderToStaticMarkup(<StaffAgentChat agentId="agent-1" agentName="Isola" />);

  it('shows the LIVE_ASSISTED mode label', () => {
    expect(html).toMatch(/Live assisted/i);
  });

  it('shows the zero-tool banner', () => {
    expect(html).toContain('No tools are enabled for this conversation. This assistant can advise but cannot act.');
  });

  it('is truthful about knowledge scope', () => {
    expect(html).toContain('It does not use a specific knowledge scope here.');
  });

  it('shows the "not saved" notice', () => {
    expect(html).toContain('This conversation is not saved — it will be cleared when you leave this page.');
  });

  it('names the agent being chatted with', () => {
    expect(html).toContain('Chat with Isola');
  });

  it('shows the empty-conversation prompt when no turns exist yet', () => {
    expect(html).toContain('Send a message to start this conversation.');
  });

  it('never renders a raw error/debug string', () => {
    expect(html).not.toMatch(/ClawithFailure|stack trace|prisma|500 Internal/i);
  });
});
