import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Owner AI Team page contract. The golden-screen recomposition must keep the
// role guard in front of every read, keep provenance honest, and — the reason
// this screen was reworked — never expose runtime/model vocabulary to a customer.

const { getSessionMock, requireWorkspaceAccessMock, getAiTeamMock, getHandoffStateMock, getWorkspaceBindingSummaryMock, redirectMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
  getAiTeamMock: vi.fn(),
  getHandoffStateMock: vi.fn(),
  getWorkspaceBindingSummaryMock: vi.fn(),
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }));
vi.mock('@/lib/workspace/tenant-workspace', () => ({
  getAiTeam: getAiTeamMock,
  getHandoffState: getHandoffStateMock,
  getWorkspaceBindingSummary: getWorkspaceBindingSummaryMock,
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import TeamPage from '../app/(owner)/team/page';

const LIVE = { source: 'isola.foundation' as const, availability: 'live' as const, dataAsOf: new Date().toISOString(), note: '' };

function session() {
  return { effectiveTenantId: 'tenant-under-test', effectiveTenant: { business_name: 'Acme Ltd' }, user: { agent_took_over: false } };
}

function grantAccess() {
  requireWorkspaceAccessMock.mockResolvedValue({ ok: true });
}

function withTeam(members: unknown[], handoff: Record<string, unknown> = {}) {
  getAiTeamMock.mockResolvedValue({ data: members, provenance: LIVE });
  getHandoffStateMock.mockResolvedValue({
    data: { humanHandlingCount: 2, escalationsLast7Days: 5, ownerTakeoverActive: false, ...handoff },
    provenance: LIVE,
  });
  getWorkspaceBindingSummaryMock.mockResolvedValue({ conversationPlatformConnected: true });
}

const MEMBER = {
  id: 'a1',
  name: 'Front Desk',
  status: 'active',
  greeting: 'Hi, how can we help?',
  runtime: 'clawith-v1.11.0 / claude-sonnet',
  channels: [{ kind: 'whatsapp', displayNumber: '+15550001111', label: 'Main line', agentSpecific: true }],
};

async function render() {
  return renderToStaticMarkup(await TeamPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(session());
});

describe('AI Team — authorization boundary', () => {
  it('redirects an unauthenticated visitor before any workspace read', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(TeamPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(requireWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(getAiTeamMock).not.toHaveBeenCalled();
  });

  it('requires manager level and renders the denial surface without reading team data', async () => {
    requireWorkspaceAccessMock.mockResolvedValue({ ok: false, error: 'You need manager access.' });
    const html = await render();
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(expect.anything(), 'manager');
    expect(html).toContain('Not available for your role');
    expect(html).toContain('You need manager access.');
    expect(getAiTeamMock).not.toHaveBeenCalled();
    expect(getHandoffStateMock).not.toHaveBeenCalled();
  });

  it('passes the session context to the guard so act-as resolves through it', async () => {
    grantAccess();
    withTeam([MEMBER]);
    await render();
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(session(), 'manager');
    expect(getAiTeamMock).toHaveBeenCalledWith(session());
    expect(getHandoffStateMock).toHaveBeenCalledWith(session());
    expect(getWorkspaceBindingSummaryMock).toHaveBeenCalledWith(session());
  });
});

describe('AI Team — customer-facing vocabulary', () => {
  it('never renders runtime or model identifiers even when the record carries them', async () => {
    grantAccess();
    withTeam([MEMBER]);
    const html = await render();
    expect(html).toContain('Front Desk');
    expect(html).not.toContain('clawith-v1.11.0');
    expect(html).not.toContain('claude-sonnet');
    expect(html).not.toMatch(/runtime/i);
  });

  it('describes handovers in human terms', async () => {
    grantAccess();
    withTeam([MEMBER]);
    const html = await render();
    expect(html).toContain('With a person');
    expect(html).toContain('Assistant asked for help');
  });
});

describe('AI Team — metrics', () => {
  it('counts assistants and enabled assistants from real records', async () => {
    grantAccess();
    withTeam([MEMBER, { ...MEMBER, id: 'a2', name: 'Bookings', status: 'paused' }]);
    const html = await render();
    expect(html).toContain('Assistants');
    expect(html).toContain('Enabled');
    expect(html).toContain('>2<');
    expect(html).toContain('>1<');
  });

  it('links the handed-over metric to the inbox', async () => {
    grantAccess();
    withTeam([MEMBER]);
    const html = await render();
    expect(html).toContain('href="/inbox"');
  });

  it('pluralises the handed-over caption correctly', async () => {
    grantAccess();
    withTeam([MEMBER], { humanHandlingCount: 1 });
    expect(await render()).toContain('Conversation handed over');
    withTeam([MEMBER], { humanHandlingCount: 4 });
    expect(await render()).toContain('Conversations handed over');
  });
});

describe('AI Team — states', () => {
  it('renders an honest empty state when the tenant has no assistants', async () => {
    grantAccess();
    withTeam([]);
    const html = await render();
    expect(html).toContain('No assistants yet');
  });

  it('surfaces the takeover badge only while owner takeover is active', async () => {
    grantAccess();
    withTeam([MEMBER], { ownerTakeoverActive: true });
    expect(await render()).toContain('You have taken over from your assistants');
    withTeam([MEMBER], { ownerTakeoverActive: false });
    expect(await render()).not.toContain('You have taken over from your assistants');
  });

  it('states plainly when the conversation platform is not connected', async () => {
    grantAccess();
    withTeam([MEMBER]);
    getWorkspaceBindingSummaryMock.mockResolvedValue({ conversationPlatformConnected: false });
    const html = await render();
    expect(html).toContain('Conversation platform not connected');
    expect(html).toContain('appear under Inbox automatically');
  });

  it('reports a channel as pending rather than inventing a number', async () => {
    grantAccess();
    withTeam([{ ...MEMBER, channels: [{ kind: 'whatsapp', displayNumber: null, label: null, agentSpecific: false }] }]);
    const html = await render();
    expect(html).toContain('Number pending');
    expect(html).toContain('Shared');
  });
});
