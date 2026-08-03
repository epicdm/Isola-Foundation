import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Foundation Inbox — /inbox/[id]. Fixes the dead "Chatwoot #<id>" chip beside
// the Resolve button (xp-foundation-inbox-chatwoot-deeplink-fix-2026-08-03):
// it must become a real, permission-gated, new-tab link to the exact bound
// Chatwoot conversation, or be omitted entirely when it would be misleading.

const { getSessionMock, prismaMock, resolveWorkspaceAuthzMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  prismaMock: { conversation: { findFirst: vi.fn() } },
  resolveWorkspaceAuthzMock: vi.fn(),
  redirectMock: vi.fn(() => { throw new Error('NEXT_REDIRECT'); }),
  notFoundMock: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: notFoundMock }));
vi.mock('@/lib/workspace/authz', async () => {
  const actual = await vi.importActual<typeof import('../lib/workspace/authz')>('../lib/workspace/authz');
  return { ...actual, resolveWorkspaceAuthz: resolveWorkspaceAuthzMock };
});

import ConversationPage from '../app/(owner)/inbox/[id]/page';
import { buildChatwootConversationLink } from '../lib/chatwoot-conversation-link';

const OWNER_AUTHZ = { level: 'owner', basis: 'membership', membershipRole: 'owner', canViewAudit: true, canViewConfiguration: true };
const DENIED_AUTHZ = { level: 'denied', basis: 'insufficient-role', membershipRole: 'staff', canViewAudit: false, canViewConfiguration: false };

const SESSION = { effectiveTenantId: 't1', user: { tenant_id: 't1' }, isAdmin: false, isOwner: true, identityId: 'id1' };

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    tenant_id: 't1',
    customer_name: 'Jane Customer',
    customer_phone: '+1868',
    status: 'open',
    messages: [],
    chatwoot_conversation_id: 9,
    chatwoot_binding: { base_url: 'https://inbox.epic.dm', account_id: '1', tenant_id: 't1' },
    ...over,
  };
}

async function render(over: Record<string, unknown> = {}, authz: unknown = OWNER_AUTHZ, session: unknown = SESSION) {
  getSessionMock.mockResolvedValue(session);
  prismaMock.conversation.findFirst.mockResolvedValue(conversation(over));
  resolveWorkspaceAuthzMock.mockResolvedValue(authz);
  return renderToStaticMarkup(await ConversationPage({ params: Promise.resolve({ id: 'c1' }) }));
}

beforeEach(() => vi.clearAllMocks());

describe('buildChatwootConversationLink (pure)', () => {
  const binding = { base_url: 'https://inbox.epic.dm', account_id: '1', tenant_id: 't1' };
  const base = { chatwootConversationId: 9, chatwootBinding: binding, conversationTenantId: 't1', canView: true };

  it('builds the exact native conversation URL when bound, valid and authorized', () => {
    expect(buildChatwootConversationLink(base)).toBe('https://inbox.epic.dm/app/accounts/1/conversations/9');
  });

  it('strips a trailing slash from base_url', () => {
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, base_url: 'https://inbox.epic.dm/' } })
    ).toBe('https://inbox.epic.dm/app/accounts/1/conversations/9');
  });

  it('returns null when the caller lacks permission', () => {
    expect(buildChatwootConversationLink({ ...base, canView: false })).toBeNull();
  });

  it('returns null when there is no Chatwoot conversation id (unbound)', () => {
    expect(buildChatwootConversationLink({ ...base, chatwootConversationId: null })).toBeNull();
  });

  it('returns null when there is no binding at all', () => {
    expect(buildChatwootConversationLink({ ...base, chatwootBinding: null })).toBeNull();
  });

  it('returns null when base_url is blank or unparseable', () => {
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, base_url: '   ' } })
    ).toBeNull();
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, base_url: 'not-a-url' } })
    ).toBeNull();
  });

  // Codex review finding [P1]: the Conversation -> ChatwootBinding relation is
  // resolved by chatwoot_binding_id alone (prisma/schema.prisma) and is not
  // itself scoped to the conversation's own tenant_id. A binding row that
  // belongs to a DIFFERENT tenant must never be turned into a link — that
  // would leak another tenant's Chatwoot account/base_url.
  it('returns null when the binding belongs to a different tenant than the conversation (cross-tenant leak)', () => {
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, tenant_id: 't2' } })
    ).toBeNull();
  });

  // Codex review finding [P2]: account_id is a free-text column. A value
  // containing a slash, dot-dot, or query/fragment character must fail closed
  // instead of being interpolated into the href as a raw path segment.
  it('returns null when account_id is not a safe path segment', () => {
    for (const unsafe of ['1/../../admin', '1?x=y', '1#frag', 'a b', '']) {
      expect(
        buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, account_id: unsafe } })
      ).toBeNull();
    }
  });

  // Codex re-review finding [P2]: a query string or fragment on base_url would
  // be silently absorbed into the appended suffix by string concatenation
  // (e.g. "https://inbox.epic.dm?x=" + "/app/accounts/2/conversations/9"
  // resolves to a query, not the intended conversation path).
  it('returns null when base_url carries a query string or fragment', () => {
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, base_url: 'https://inbox.epic.dm?x=1' } })
    ).toBeNull();
    expect(
      buildChatwootConversationLink({ ...base, chatwootBinding: { ...binding, base_url: 'https://inbox.epic.dm#frag' } })
    ).toBeNull();
  });
});

describe('Inbox conversation detail — Chatwoot deep link', () => {
  it('1: a bound, authorized conversation renders a real accessible link with the correct href', async () => {
    const html = await render();
    expect(html).toContain('href="https://inbox.epic.dm/app/accounts/1/conversations/9"');
    expect(html).toContain('Chatwoot #9');
  });

  it('2: the link opens in a new tab safely', async () => {
    const html = await render();
    expect(html).toMatch(/<a[^>]*href="https:\/\/inbox\.epic\.dm\/app\/accounts\/1\/conversations\/9"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('3: an unbound conversation renders no misleading Chatwoot chip', async () => {
    const html = await render({ chatwoot_conversation_id: null });
    expect(html).not.toContain('inbox.epic.dm');
    expect(html).not.toContain('Chatwoot #');
  });

  it('3b: a conversation with no Chatwoot binding row renders no misleading chip', async () => {
    const html = await render({ chatwoot_binding: null });
    expect(html).not.toContain('Chatwoot #');
  });

  it('4: a missing/invalid base URL renders no misleading chip', async () => {
    const html = await render({ chatwoot_binding: { base_url: '', account_id: '1', tenant_id: 't1' } });
    expect(html).not.toContain('Chatwoot #');
  });

  it('5: an unauthorized (denied-level) user receives no native Chatwoot link', async () => {
    const html = await render({}, DENIED_AUTHZ);
    expect(html).not.toContain('inbox.epic.dm');
    expect(html).not.toContain('Chatwoot #');
  });

  it('5b: a binding belonging to another tenant never renders (cross-tenant leak stays closed end-to-end)', async () => {
    const html = await render({ chatwoot_binding: { base_url: 'https://inbox.epic.dm', account_id: '1', tenant_id: 't2' } });
    expect(html).not.toContain('inbox.epic.dm');
    expect(html).not.toContain('Chatwoot #');
  });

  it('6: Resolve behaviour is unchanged regardless of Chatwoot link state', async () => {
    const openHtml = await render({ status: 'open' });
    expect(openHtml).toContain(`action="/api/conversations/c1"`);
    expect(openHtml).toContain('method="PATCH"');
    expect(openHtml).toContain('value="resolved"');
    expect(openHtml).toContain('>Resolve<');

    const resolvedHtml = await render({ status: 'resolved' }, DENIED_AUTHZ);
    expect(resolvedHtml).toContain('value="open"');
    expect(resolvedHtml).toContain('>Reopen<');
  });

  it('7: unrelated conversation content still renders unchanged', async () => {
    const html = await render();
    expect(html).toContain('Jane Customer');
    expect(html).toContain('>open<');
  });
});
